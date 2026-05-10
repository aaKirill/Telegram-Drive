import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { Folder, MoreVertical, Check } from 'lucide-react';
import { invoke, resolveMediaUrl } from '../../lib/transport';
import { TelegramFile } from '../../types';
import { FileTypeIcon } from '../FileTypeIcon';
import { useLongPress } from '../../hooks/useLongPress';
import { useIsMobile } from '../../hooks/useIsMobile';
import { isImageFile } from '../../utils';

// Module-level cache for client-probed video durations. Files uploaded
// before our server-side `DocumentAttributeVideo` fix shipped don't
// carry duration metadata on Telegram, so the FileCard probes the
// stream URL with a hidden <video preload="metadata"> as a fallback.
// One-shot per id; the result is keyed by `${folderId ?? 'home'}:${id}`
// so the same file viewed from search vs. its home folder shares state.
const probedDurations = new Map<string, number>();
const probesInFlight = new Map<string, Promise<number | null>>();
const probeKey = (folderId: number | null, id: number) => `${folderId ?? 'home'}:${id}`;
async function probeVideoDuration(folderId: number | null, id: number): Promise<number | null> {
    const k = probeKey(folderId, id);
    if (probedDurations.has(k)) return probedDurations.get(k)!;
    const pending = probesInFlight.get(k);
    if (pending) return await pending;
    const work = (async () => {
        try {
            const url = await resolveMediaUrl(folderId, id);
            return await new Promise<number | null>((resolve) => {
                const v = document.createElement('video');
                v.preload = 'metadata';
                v.muted = true;
                let done = false;
                const finish = (val: number | null) => {
                    if (done) return;
                    done = true;
                    v.removeAttribute('src');
                    if (val !== null && val > 0) probedDurations.set(k, val);
                    resolve(val);
                };
                v.onloadedmetadata = () => {
                    const d = Number.isFinite(v.duration) ? Math.ceil(v.duration) : 0;
                    finish(d > 0 ? d : null);
                };
                v.onerror = () => finish(null);
                setTimeout(() => finish(null), 8000);
                v.src = url;
            });
        } catch {
            return null;
        } finally {
            probesInFlight.delete(k);
        }
    })();
    probesInFlight.set(k, work);
    return await work;
}

// Stripped down isVideoFile — utils only exports isMediaFile (images +
// videos lumped together) and isImageFile. We need to distinguish video
// from image so the mobile name-hide rule (image/video only) is precise.
function isVideoFileName(name: string): boolean {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    return ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].includes(ext);
}

/** Format seconds as h:mm:ss for >= 1h, otherwise m:ss. iOS Photos
 *  drops the leading hours when 0. Used for the time pill on video
 *  thumbnails. */
function formatDuration(secs: number): string {
    const s = Math.floor(secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

interface FileCardProps {
    file: TelegramFile;
    onDelete: () => void;
    onDownload: () => void;
    onPreview?: () => void;
    isSelected: boolean;
    onClick?: (e: React.MouseEvent) => void;
    onDoubleClick?: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    disableThumbnail?: boolean;
    onDrop?: (e: React.DragEvent, folderId: number) => void;
    onDragStart?: (fileId: number) => void;
    onDragEnd?: () => void;
    activeFolderId?: number | null;
    height?: number;
    onToggleSelection?: () => void;
    /** Mobile-only: when true, the selection check is always rendered
     *  (Photos-style) even on unselected cards so the user can see what's
     *  about to be tapped. Off when the user is in preview mode. */
    selectMode?: boolean;
}

// Check if file has a thumbnail available (images + videos with poster frames)
function hasThumbnail(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext);
}

export function FileCard({ file, onDelete, onDownload, onPreview, isSelected, onClick, onDoubleClick, onContextMenu, onDrop, onDragStart, onDragEnd, activeFolderId, height, onToggleSelection, disableThumbnail, selectMode }: FileCardProps) {
    const isFolder = file.type === 'folder';
    const [isDragOver, setIsDragOver] = useState(false);
    const [thumbnail, setThumbnail] = useState<string | null>(null);
    const [thumbnailLoading, setThumbnailLoading] = useState(false);
    const isMobile = useIsMobile();
    void onDelete; void onDownload; void onPreview;

    // Client-side duration fallback for videos missing the server-side
    // DocumentAttributeVideo. Probes the stream URL once per file via
    // an off-screen <video preload="metadata"> and caches at module
    // scope so re-mounts don't re-fetch.
    const [probedDuration, setProbedDuration] = useState<number | null>(null);
    const isVideo = !isFolder && isVideoFileName(file.name);
    const needsProbe = isVideo && (file.duration_secs == null || file.duration_secs === 0);
    useEffect(() => {
        if (!needsProbe) return;
        let cancelled = false;
        const folderId = file.folder_id ?? activeFolderId ?? null;
        const cached = probedDurations.get(probeKey(folderId, file.id));
        if (cached) { setProbedDuration(cached); return; }
        probeVideoDuration(folderId, file.id).then((d) => {
            if (!cancelled && d !== null) setProbedDuration(d);
        });
        return () => { cancelled = true; };
    }, [file.id, file.folder_id, activeFolderId, needsProbe]);
    const effectiveDurationSecs = file.duration_secs && file.duration_secs > 0
        ? file.duration_secs
        : probedDuration;

    // Long-press → synthesize a context-menu open at the touch point.
    // Reuses the existing onContextMenu handler the parent already wired
    // up for right-click; the ContextMenu component reads clientX/clientY
    // off the event to position itself.
    const longPress = useLongPress(({ x, y }) => {
        if (!onContextMenu) return;
        const synthetic = { preventDefault: () => {}, stopPropagation: () => {}, clientX: x, clientY: y } as unknown as React.MouseEvent;
        onContextMenu(synthetic);
    });

    // Lazy load thumbnail for image files
    useEffect(() => {
        if (isFolder || !hasThumbnail(file.name) || disableThumbnail) {
            // If a thumbnail had been loaded for a previous render, drop it
            // so flipping the global "Hide thumbnails" setting takes effect
            // immediately instead of waiting for the next mount.
            if (disableThumbnail && thumbnail) setThumbnail(null);
            return;
        }

        let cancelled = false;
        setThumbnailLoading(true);

        const thumbFolderId =
            file.folder_id !== undefined && file.folder_id !== null
                ? file.folder_id
                : (activeFolderId ?? null);
        invoke<string>('cmd_get_thumbnail', {
            messageId: file.id,
            folderId: thumbFolderId
        }).then((result) => {
            if (!cancelled && result) {
                setThumbnail(result);
            }
        }).catch(() => {
            // Silently fail - will show icon instead
        }).finally(() => {
            if (!cancelled) setThumbnailLoading(false);
        });

        return () => { cancelled = true; };
    }, [file.id, file.name, activeFolderId, isFolder, disableThumbnail]);

    // longPress.onClick is a click suppressor that runs after a long-press
    // fires on iOS — it eats the synthesized trailing click so we don't
    // open the preview/toggle right after the menu. Compose it manually:
    // suppressor first, then the real onClick (early-return if suppressed).
    const composedClick = (e: React.MouseEvent) => {
        longPress.onClick(e);
        if (e.defaultPrevented) return;
        if (onClick) onClick(e);
    };

    // On mobile, every selected file is rendered with a uniform darken
    // overlay (Photos-app style). No orange ring on any type — the
    // checkmark badge in the corner is the per-cell signal, the dim
    // overlay is the page-wide signal.
    const isMediaItem = !isFolder && (isImageFile(file.name) || isVideoFileName(file.name));
    void isMediaItem; // kept for the caption-rule below
    const mobileSelectedClass = '';

    return (
        <div
            className={`relative select-none w-full h-full ${mobileSelectedClass}`}
            data-file-id={file.id}
            // Suppress iOS Safari's native long-press menu (image-save,
            // share-sheet, link callout). Without this, our context menu
            // and the OS one both open and the user sees a "3x flicker".
            style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
            onContextMenu={onContextMenu}
            onDoubleClick={onDoubleClick}
            onTouchStart={longPress.onTouchStart}
            onTouchMove={longPress.onTouchMove}
            onTouchEnd={longPress.onTouchEnd}
            onTouchCancel={longPress.onTouchCancel}
            onClick={composedClick}
            onMouseDown={(e) => {
                // Block the browser's default shift-click "extend text selection"
                // behaviour. Without this, the user gets the highlighted text
                // strip across cards AND the native selection can intercept the
                // click event in a way that breaks shift-range selection.
                if (e.shiftKey) e.preventDefault();
            }}
            onDragOver={(e) => {
                if (isFolder) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isDragOver) setIsDragOver(true);
                }
            }}
            onDragLeave={(e) => {
                if (isFolder) {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(false);
                }
            }}
            onDrop={(e) => {
                if (isFolder && onDrop) {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(false);
                    onDrop(e, file.id);
                }
            }}
        >
            <motion.div
                // Drag-to-move is disabled in Select mode (no double-meaning
                // for tap/drag) and on mobile (touch drag is unreliable).
                draggable={!isFolder && !isMobile && !selectMode}
                onDragStart={(e: any) => {
                    if (onDragStart) onDragStart(file.id);
                    e.dataTransfer.setData("application/x-telegram-file-id", file.id.toString());
                    e.dataTransfer.effectAllowed = 'move';
                    const target = e.currentTarget as HTMLElement;
                    e.dataTransfer.setDragImage(target, target.clientWidth / 2, target.clientHeight / 2);
                }}
                onDragEnd={() => {
                    if (onDragEnd) onDragEnd();
                }}
                className={`group cursor-pointer overflow-hidden relative transition-colors w-full
                ${isMobile
                    ? 'bg-telegram-hover'
                    : `bg-telegram-surface rounded-xl border ${isSelected ? 'border-telegram-primary ring-1 ring-telegram-primary' : 'border-telegram-border hover:border-telegram-primary/40'}`}
                ${isDragOver ? 'ring-2 ring-telegram-primary' : ''}`}
                style={height ? { height: `${height}px` } : { aspectRatio: isMobile ? '1/1' : '4/3' }}
            >
                {/* Thumbnail or Icon */}
                {thumbnail ? (
                    <div className="absolute inset-0">
                        <img
                            src={thumbnail}
                            alt={file.name}
                            draggable={false}
                            className="w-full h-full object-cover pointer-events-none"
                            style={{ WebkitTouchCallout: 'none' }}
                        />
                        {/* Filename gradient overlay — desktop only. Mobile is
                            iOS-Photos-style: thumbnail-only, name on tap. */}
                        {!isMobile && (
                            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                        )}
                    </div>
                ) : (
                    <div className={`absolute inset-0 flex items-center justify-center ${isMobile ? 'p-2 pb-7' : 'p-4'}`}>
                        {isFolder ? (
                            <Folder className={`${isMobile ? 'w-12 h-12' : 'w-12 h-12'} text-telegram-primary`} />
                        ) : thumbnailLoading && hasThumbnail(file.name) ? (
                            <div className="w-8 h-8 border-2 border-telegram-primary/30 border-t-telegram-primary rounded-full animate-spin" />
                        ) : (
                            <FileTypeIcon
                                filename={file.name}
                                className={isMobile ? 'w-12 h-12' : undefined}
                                size={isMobile ? undefined : 'lg'}
                            />
                        )}
                    </div>
                )}

                {/* Uniform darken overlay for selected files on mobile —
                    applies to images, videos, documents, audio alike, so
                    the visual signal "this is selected" is consistent. */}
                {isMobile && isSelected && (
                    <div className="absolute inset-0 bg-black/45 z-[5] pointer-events-none" aria-hidden="true" />
                )}

                {/* Video duration pill — Photos-style. Top-right corner,
                    matches the OS app's small pill so users can spot
                    videos at a glance even in the tight 3-col mobile grid. */}
                {isVideo && effectiveDurationSecs && effectiveDurationSecs > 0 && (
                    <div className="absolute top-1.5 right-1.5 z-10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums rounded bg-black/55 text-white pointer-events-none">
                        {formatDuration(effectiveDurationSecs)}
                    </div>
                )}

                {/* Selection check rules:
                    - Mobile: ONLY rendered when this card is actually
                      selected. iOS Photos pattern — entering select mode
                      doesn't decorate every card with a hollow circle;
                      only the picked items get a checkmark. The outline
                      ring (rendered on the outer wrapper) is what tells
                      the user the card is selected.
                    - Desktop: tiny hollow circle on hover, filled when
                      selected. Click-to-select happens here. */}
                {isMobile && isSelected && (
                    <div
                        className="absolute bottom-1.5 right-1.5 z-10 pointer-events-none"
                        aria-hidden="true"
                    >
                        <div className="w-6 h-6 rounded-full bg-telegram-primary flex items-center justify-center shadow-sm">
                            <Check className="w-4 h-4 text-white" strokeWidth={3} />
                        </div>
                    </div>
                )}
                {!isMobile && (
                    <div
                        data-checkbox-handle="true"
                        onClick={(e) => {
                            e.stopPropagation();
                            if (onToggleSelection) onToggleSelection();
                        }}
                        className={`absolute top-0 left-0 p-2 z-10 cursor-pointer transition-opacity ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                        style={{ touchAction: 'manipulation' }}
                        aria-label={isSelected ? 'Deselect' : 'Select'}
                    >
                        <div className={`w-5 h-5 rounded-full border flex items-center justify-center ${isSelected ? 'bg-telegram-primary border-telegram-primary' : 'border-white/70 bg-black/40'}`}>
                            {isSelected && <div className="w-1.5 h-1.5 bg-black rounded-full" />}
                        </div>
                    </div>
                )}

                {/* Filename strip rules:
                    - Mobile: ONLY for non-image/non-video files. Photos-style
                      strips chrome from media so the thumbnails fill the cell.
                    - Desktop: name is always the priority; size is shown only
                      at wider cards (>=200px). At 8/10/12 cols, cards are
                      ~160px → name only (truncated, small). */}
                {(() => {
                    const isMedia = isImageFile(file.name) || isVideoFileName(file.name);
                    if (isFolder) return null;
                    if (isMobile && isMedia) return null;

                    const w = height ?? 200;
                    const showSize = w >= 200;
                    const compactName = w < 200;
                    const subtle = isMobile;

                    return (
                        <div
                            className={`absolute bottom-0 left-0 right-0 ${compactName ? 'p-1.5' : 'p-3'} ${thumbnail ? 'text-white' : 'text-telegram-text'} ${subtle ? 'opacity-90' : ''}`}
                        >
                            <h3
                                className={`${compactName ? 'text-[11px] leading-tight' : 'text-sm'} font-medium truncate w-full`}
                                title={file.name}
                            >
                                {file.name}
                            </h3>
                            {showSize && (
                                <p
                                    className={`text-xs mt-0.5 ${thumbnail ? 'text-white/70' : 'text-telegram-subtext'}`}
                                >
                                    {file.sizeStr}
                                </p>
                            )}
                        </div>
                    );
                })()}

                {/* Quick actions — desktop only, single kebab that opens the
                    context menu (replaces the previous Eye/Download/Delete trio
                    that took too much top-right real estate). */}
                {!isMobile && (
                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                if (onContextMenu) {
                                    onContextMenu(e);
                                }
                            }}
                            className="file-action-btn p-1 bg-black/50 rounded-full hover:bg-telegram-primary hover:text-white text-white/80"
                            title="More"
                            aria-label="More"
                        >
                            <MoreVertical className="w-3.5 h-3.5" />
                        </button>
                    </div>
                )}
            </motion.div>
        </div>
    )
}

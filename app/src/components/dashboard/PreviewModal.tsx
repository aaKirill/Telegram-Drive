import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, File, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { invoke } from '../../lib/transport';
import { convertFileSrc } from '../../lib/transport';
import { toast } from 'sonner';
import { TelegramFile } from '../../types';
import { isImageFile } from '../../utils';
import { useIsMobile } from '../../hooks/useIsMobile';

const PREVIEW_CACHE_TTL_MS = 5 * 60 * 1000;
const PREVIEW_CACHE_MAX_ITEMS = 8;

type PreviewCacheValue = {
    src: string;
    cachedAt: number;
};

const previewCache = new Map<string, PreviewCacheValue>();
const pendingPrefetch = new Set<string>();

const getPreviewCacheKey = (fileId: number, folderId: number | null) => `${folderId ?? 'home'}:${fileId}`;

/** Resolve the channel/peer a file actually lives in. Files served by global
 *  search carry their own `folder_id` because they may live in a different
 *  channel than the dashboard's currently-active folder; without this
 *  `cmd_get_preview` would resolve the peer to Saved Messages and return
 *  "File not found" for any cross-channel preview. */
const effectiveFolderId = (file: TelegramFile, activeFolderId: number | null): number | null => {
    const fid = file.folder_id;
    return fid !== undefined && fid !== null ? fid : activeFolderId;
};

const touchPreviewCache = (key: string, value: PreviewCacheValue) => {
    if (previewCache.has(key)) previewCache.delete(key);
    previewCache.set(key, value);

    while (previewCache.size > PREVIEW_CACHE_MAX_ITEMS) {
        const oldestKey = previewCache.keys().next().value;
        if (!oldestKey) break;
        previewCache.delete(oldestKey);
    }
};

const getCachedPreview = (key: string): string | null => {
    const value = previewCache.get(key);
    if (!value) return null;

    if (Date.now() - value.cachedAt > PREVIEW_CACHE_TTL_MS) {
        previewCache.delete(key);
        return null;
    }

    touchPreviewCache(key, value);
    return value.src;
};

const rememberPreview = (key: string, src: string) => {
    touchPreviewCache(key, { src, cachedAt: Date.now() });
};

const forgetPreview = (key: string) => {
    previewCache.delete(key);
};

const isSafeToPrefetch = (name: string) => isImageFile(name);

interface PreviewModalProps {
    file: TelegramFile;
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    currentIndex?: number;
    totalItems?: number;
    nextFile?: TelegramFile | null;
    prevFile?: TelegramFile | null;
    activeFolderId: number | null;
}

export function PreviewModal({ file, onClose, onNext, onPrev, currentIndex, totalItems, nextFile, prevFile, activeFolderId }: PreviewModalProps) {
    const [src, setSrc] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [reloadNonce, setReloadNonce] = useState(0);
    const [retryCount, setRetryCount] = useState(0);
    const latestRequestRef = useRef(0);
    const isMobile = useIsMobile();

    useEffect(() => {
        setRetryCount(0);
        setReloadNonce(0);
    }, [file.id, activeFolderId]);

    useEffect(() => {
        const load = async () => {
            const folderId = effectiveFolderId(file, activeFolderId);
            const key = getPreviewCacheKey(file.id, folderId);
            const shouldBypassCache = reloadNonce > 0;
            const requestId = ++latestRequestRef.current;

            // For non-image files we don't render a preview — the modal shows
            // an "Open with system app" panel that downloads on demand. Skip
            // the eager fetch entirely so docx/epub/etc. don't surface a
            // misleading "File not found" error before the user clicks Open.
            if (!isImageFile(file.name)) {
                setSrc(null);
                setLoading(false);
                setError(null);
                return;
            }

            const cachedSrc = shouldBypassCache ? null : getCachedPreview(key);

            if (cachedSrc) {
                if (requestId !== latestRequestRef.current) return;
                setSrc(cachedSrc);
                setLoading(false);
                setError(null);
                return;
            }

            setLoading(true);
            setError(null);
            try {
                const path = await invoke<string>('cmd_get_preview', {
                    messageId: file.id,
                    folderId
                });
                if (requestId !== latestRequestRef.current) return;

                if (path) {
                    if (path.startsWith('data:')) {
                        setSrc(path);
                        rememberPreview(key, path);
                    } else {
                        const converted = convertFileSrc(path);
                        setSrc(converted);
                        rememberPreview(key, converted);
                    }
                } else {
                    setError("Preview not available");
                }
            } catch (e) {
                if (requestId !== latestRequestRef.current) return;
                setError(String(e));
            } finally {
                if (requestId !== latestRequestRef.current) return;
                setLoading(false);
            }
        };
        load();
    }, [file, activeFolderId, reloadNonce]);

    useEffect(() => {
        const candidates = [nextFile, prevFile].filter((f): f is TelegramFile => !!f && isSafeToPrefetch(f.name));

        candidates.forEach((candidate) => {
            const candidateFolderId = effectiveFolderId(candidate, activeFolderId);
            const key = getPreviewCacheKey(candidate.id, candidateFolderId);
            if (getCachedPreview(key) || pendingPrefetch.has(key)) return;

            pendingPrefetch.add(key);
            invoke<string>('cmd_get_preview', {
                messageId: candidate.id,
                folderId: candidateFolderId
            }).then((path) => {
                if (!path) return;
                const normalized = path.startsWith('data:') ? path : convertFileSrc(path);
                rememberPreview(key, normalized);
            }).catch(() => {
                // Ignore prefetch errors, main preview flow will handle user-visible failures.
            }).finally(() => {
                pendingPrefetch.delete(key);
            });
        });
    }, [nextFile, prevFile, activeFolderId]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
                return;
            }

            const key = e.key.toLowerCase();

            if (e.key === 'ArrowRight' || key === 'l') {
                e.preventDefault();
                onNext?.();
                return;
            }

            if (e.key === 'ArrowLeft' || key === 'j') {
                e.preventDefault();
                onPrev?.();
                return;
            }

            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose, onNext, onPrev]);

    // Touch swipe → prev/next. Threshold tuned for thumb gestures: 60px is
    // far enough to avoid scroll-jitter triggers but short enough to feel
    // responsive. Vertical-dominant motions are ignored so a user scrolling
    // text inside the modal isn't fighting horizontal nav.
    const touchStartRef = useRef<{ x: number; y: number } | null>(null);
    const swipedRef = useRef(false);
    // Track direction of the last navigation so AnimatePresence can slide
    // the image in from the correct side. +1 = next (slides in from right),
    // -1 = prev (slides in from left).
    const [navDir, setNavDir] = useState<1 | -1>(1);
    const onTouchStart = (e: React.TouchEvent) => {
        swipedRef.current = false;
        if (e.touches.length !== 1) { touchStartRef.current = null; return; }
        touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };
    const onTouchEnd = (e: React.TouchEvent) => {
        const start = touchStartRef.current;
        touchStartRef.current = null;
        if (!start) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
        // Mark this gesture as a swipe so the trailing tap doesn't close
        // the modal — without this, every swipe would also fire onClose.
        swipedRef.current = true;
        if (dx > 0) { setNavDir(-1); if (onPrev) onPrev(); }
        else { setNavDir(1); if (onNext) onNext(); }
    };
    const handleBackdropClick = () => {
        if (swipedRef.current) {
            swipedRef.current = false;
            return;
        }
        onClose();
    };

    // Outer wrapper layout differs between platforms:
    //   - Mobile: column with top chrome bar above the image. The image
    //     fills available space below; tap anywhere outside chrome closes.
    //   - Desktop: centered with a max-width box; backdrop area around
    //     the image is the close-on-click region (matches the original
    //     "click outside the picture to dismiss" pattern).
    const outerClass = isMobile
        ? "fixed inset-0 z-[150] bg-black/95 flex flex-col items-stretch backdrop-blur-sm"
        : "fixed inset-0 z-[150] bg-black/95 flex items-center justify-center p-2 sm:p-4 backdrop-blur-sm";
    const innerClass = isMobile
        ? "relative flex-1 flex items-center justify-center p-0"
        : "relative w-full max-w-5xl max-h-screen flex flex-col items-center justify-center";

    return (
        <div
            className={outerClass}
            onClick={handleBackdropClick}
            // Mobile uses framer-motion drag on the image element itself
            // (drag-to-scrub with snap-back), so the outer-level swipe
            // detector here is desktop-only. Without that gate, the two
            // would race: framer's onDragEnd would fire navigation, and
            // touchend on the wrapper would fire it again.
            onTouchStart={isMobile ? undefined : onTouchStart}
            onTouchEnd={isMobile ? undefined : onTouchEnd}
        >
            {/* Mobile chrome strip — outer wrapper owns the
                safe-area-inset-top padding; the inner row keeps a fixed
                h-12 so the close button stays full-size below the iOS
                status bar. Close button on the RIGHT (consistent with
                iOS / standard close-button conventions). */}
            {isMobile && (
                <div
                    className="bg-black/60 border-b border-white/10 shrink-0"
                    style={{ paddingTop: 'env(safe-area-inset-top)' }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex items-center gap-2 px-3 h-12">
                        <div className="flex-1 min-w-0 text-white text-sm truncate" title={file.name}>
                            {file.name}
                        </div>
                        {typeof currentIndex === 'number' && typeof totalItems === 'number' && totalItems > 0 && (
                            <div className="text-white/60 text-xs shrink-0 tabular-nums">
                                {currentIndex + 1}/{totalItems}
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={onClose}
                            className="p-2 -mr-1 rounded-md text-white/80 hover:text-white active:bg-white/10 transition shrink-0"
                            style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                            aria-label="Close"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>
            )}

            <div
                className={innerClass}
                // Don't trap clicks. Buttons inside (chevrons, X, "Open
                // with system app") all stopPropagation in their own
                // handlers, so a tap on empty space — including on the
                // image itself — bubbles up to the outer onClose. This
                // matches user expectation: clicking the image dismisses
                // the preview, not just the surrounding void.
            >
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setNavDir(-1); if (onPrev) onPrev(); }}
                    className="absolute left-1 sm:left-2 top-1/2 -translate-y-1/2 p-2 bg-black/50 hover:bg-black/80 rounded-full transition-colors z-10"
                    style={{ color: '#ffffff', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                    title="Previous (ArrowLeft / J)"
                    aria-label="Previous"
                >
                    <ChevronLeft className="w-5 h-5 sm:w-6 sm:h-6" />
                </button>

                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setNavDir(1); if (onNext) onNext(); }}
                    className="absolute right-1 sm:right-2 top-1/2 -translate-y-1/2 p-2 bg-black/50 hover:bg-black/80 rounded-full transition-colors z-10"
                    style={{ color: '#ffffff', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                    title="Next (ArrowRight / L)"
                    aria-label="Next"
                >
                    <ChevronRight className="w-5 h-5 sm:w-6 sm:h-6" />
                </button>

                {/* Desktop close button — outside the centered viewing area
                    so it doesn't crowd the image. Mobile uses the top bar
                    rendered above. */}
                {!isMobile && (
                    <button
                        type="button"
                        onClick={onClose}
                        className="absolute top-2 right-2 sm:-top-12 sm:right-0 p-2 bg-black/60 hover:bg-black/80 rounded-full transition-colors z-10"
                        style={{ color: '#ffffff' }}
                        aria-label="Close"
                    >
                        <X className="w-5 h-5 sm:w-6 sm:h-6" />
                    </button>
                )}

                {loading && (
                    <div className="flex flex-col items-center gap-4 text-white">
                        <div className="w-10 h-10 border-4 border-telegram-primary border-t-transparent rounded-full animate-spin"></div>
                        <p>Loading preview...</p>
                        <p className="text-xs text-white/50">Downloading from Telegram...</p>
                    </div>
                )}

                {error && (
                    <div className="text-red-400 bg-white/10 p-4 rounded-lg border border-red-500/20">
                        <p className="font-bold">Preview Error</p>
                        <p className="text-sm">{error}</p>
                    </div>
                )}

                {!loading && !error && (src || !isImageFile(file.name)) && (
                    <div className="flex flex-col items-center max-h-full">
                        {isImageFile(file.name) && src ? (
                            isMobile ? (
                                // Mobile: drag-to-scrub. Image follows the
                                // finger horizontally; on release, if the
                                // user dragged past the threshold, commit
                                // the nav (motion.div snaps back to 0
                                // because dragConstraints left=right=0).
                                // The new image fades in via the variant
                                // wrapper below.
                                <motion.img
                                    key={file.id}
                                    src={src}
                                    draggable={false}
                                    drag="x"
                                    dragConstraints={{ left: 0, right: 0 }}
                                    dragElastic={0.6}
                                    dragMomentum={false}
                                    onDragEnd={(_, info) => {
                                        const dx = info.offset.x;
                                        if (Math.abs(dx) < 60) return;
                                        // Mark as a swipe so the trailing
                                        // tap doesn't also fire onClose.
                                        swipedRef.current = true;
                                        if (dx > 0) { setNavDir(-1); onPrev?.(); }
                                        else { setNavDir(1); onNext?.(); }
                                    }}
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{ duration: 0.15 }}
                                    className="max-w-full max-h-full object-contain bg-black"
                                    alt="Preview"
                                    onError={() => {
                                        const key = getPreviewCacheKey(file.id, effectiveFolderId(file, activeFolderId));
                                        forgetPreview(key);
                                        if (retryCount < 1) {
                                            setRetryCount((prev) => prev + 1);
                                            setReloadNonce((prev) => prev + 1);
                                            return;
                                        }
                                        setError('Failed to render image preview');
                                    }}
                                />
                            ) : (
                                <AnimatePresence mode="popLayout" initial={false} custom={navDir}>
                                    <motion.img
                                        key={file.id}
                                        src={src}
                                        draggable={false}
                                        custom={navDir}
                                        variants={{
                                            enter: (d: number) => ({ x: d * 60, opacity: 0 }),
                                            center: { x: 0, opacity: 1 },
                                            exit: (d: number) => ({ x: -d * 60, opacity: 0 }),
                                        }}
                                        initial="enter"
                                        animate="center"
                                        exit="exit"
                                        transition={{ duration: 0.18, ease: 'easeOut' }}
                                        className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl bg-black"
                                        alt="Preview"
                                        onError={() => {
                                            const key = getPreviewCacheKey(file.id, effectiveFolderId(file, activeFolderId));
                                            forgetPreview(key);

                                            if (retryCount < 1) {
                                                setRetryCount((prev) => prev + 1);
                                                setReloadNonce((prev) => prev + 1);
                                                return;
                                            }

                                            setError('Failed to render image preview');
                                        }}
                                    />
                                </AnimatePresence>
                            )
                        ) : (
                            <div className="bg-[#1c1c1c] p-8 rounded-xl text-center border border-white/10 shadow-2xl">
                                <File className="w-16 h-16 text-telegram-primary mx-auto mb-4" />
                                <h3 className="text-xl text-white font-medium mb-2">{file.name}</h3>
                                <p className="text-gray-400 mb-4">Inline preview not supported.</p>
                                <p className="text-xs text-gray-500 mb-4">File type: {file.name.split('.').pop()}</p>
                                <button
                                    onClick={async (e) => {
                                        e.stopPropagation();
                                        try {
                                            const path = await invoke<string>('cmd_get_preview', {
                                                messageId: file.id,
                                                folderId: effectiveFolderId(file, activeFolderId),
                                            });
                                            if (!path) {
                                                toast.error('Could not download file');
                                                return;
                                            }
                                            if (path.startsWith('data:')) {
                                                toast.error('File returned inline; nothing to open externally');
                                                return;
                                            }
                                            // Pass the source filename so the
                                            // web build can trigger an `<a download>`
                                            // with the right extension. Tauri ignores
                                            // the extra arg (it uses the cached path's
                                            // basename for OS app association).
                                            await invoke('cmd_open_path', { path, filename: file.name });
                                        } catch (e) {
                                            toast.error(`Open failed: ${e}`);
                                        }
                                    }}
                                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-telegram-primary hover:bg-telegram-primary/80 text-white text-sm transition-colors"
                                >
                                    <ExternalLink className="w-4 h-4" />
                                    Open with system app
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {/* Bottom filename strip — desktop only. Mobile shows the
                    name in the top bar so it never crosses the image. */}
                {!isMobile && (
                    <div className="absolute bottom-[-3rem] left-1/2 -translate-x-1/2 max-w-[90%] truncate text-white text-sm opacity-50 text-center px-3 py-1">
                        {file.name}
                        {typeof currentIndex === 'number' && typeof totalItems === 'number' && totalItems > 0 && (
                            <span className="ml-3">{currentIndex + 1}/{totalItems}</span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

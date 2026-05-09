import { useState, useEffect, useRef } from 'react';
import { X, File, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { invoke } from '../../lib/transport';
import { convertFileSrc } from '../../lib/transport';
import { toast } from 'sonner';
import { TelegramFile } from '../../types';
import { isImageFile } from '../../utils';

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

    return (
        <div className="fixed inset-0 z-[150] bg-black/90 flex items-center justify-center p-4 backdrop-blur-sm" onClick={onClose}>
            <div className="relative max-w-5xl w-full max-h-screen flex flex-col items-center justify-center" onClick={e => e.stopPropagation()}>
                <button
                    onClick={onPrev}
                    className="absolute left-2 top-1/2 -translate-y-1/2 p-2 bg-black/60 hover:bg-black/80 rounded-full transition-colors"
                    style={{ color: '#ffffff' }}
                    title="Previous (ArrowLeft / J)"
                >
                    <ChevronLeft className="w-6 h-6" />
                </button>

                <button
                    onClick={onNext}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-black/60 hover:bg-black/80 rounded-full transition-colors"
                    style={{ color: '#ffffff' }}
                    title="Next (ArrowRight / L)"
                >
                    <ChevronRight className="w-6 h-6" />
                </button>

                <button
                    onClick={onClose}
                    className="absolute -top-12 right-0 p-2 bg-black/60 hover:bg-black/80 rounded-full transition-colors"
                    style={{ color: '#ffffff' }}
                >
                    <X className="w-6 h-6" />
                </button>

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
                    <div className="flex flex-col items-center">
                        {isImageFile(file.name) && src ? (
                            <img
                                src={src}
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
                        ) : (
                            <div className="bg-[#1c1c1c] p-8 rounded-xl text-center border border-white/10 shadow-2xl">
                                <File className="w-16 h-16 text-telegram-primary mx-auto mb-4" />
                                <h3 className="text-xl text-white font-medium mb-2">{file.name}</h3>
                                <p className="text-gray-400 mb-4">Inline preview not supported.</p>
                                <p className="text-xs text-gray-500 mb-4">File type: {file.name.split('.').pop()}</p>
                                <button
                                    onClick={async () => {
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
                                            await invoke('cmd_open_path', { path });
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

                <div className="absolute bottom-[-3rem] text-white text-sm opacity-50">
                    {file.name}
                    {typeof currentIndex === 'number' && typeof totalItems === 'number' && totalItems > 0 && (
                        <span className="ml-3">{currentIndex + 1}/{totalItems}</span>
                    )}
                </div>
            </div>
        </div>
    );
}

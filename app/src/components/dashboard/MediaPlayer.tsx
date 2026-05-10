import { useEffect, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { invoke, resolveMediaUrl } from '../../lib/transport';
import { TelegramFile } from '../../types';
import { isVideoFile, isAudioFile } from '../../utils';
import { useIsMobile } from '../../hooks/useIsMobile';

const VOLUME_KEY = 'mediaPlayerVolume';
const MUTED_KEY = 'mediaPlayerMuted';

function applyStoredVolume(el: HTMLMediaElement) {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? '');
    if (!Number.isNaN(v) && v >= 0 && v <= 1) el.volume = v;
    el.muted = localStorage.getItem(MUTED_KEY) === 'true';
}

function persistVolumeHandler(el: HTMLMediaElement) {
    return () => {
        localStorage.setItem(VOLUME_KEY, String(el.volume));
        localStorage.setItem(MUTED_KEY, String(el.muted));
    };
}

interface MediaPlayerProps {
    file: TelegramFile;
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    currentIndex?: number;
    totalItems?: number;
    activeFolderId: number | null;
}

export function MediaPlayer({ file, onClose, onNext, onPrev, currentIndex, totalItems, activeFolderId }: MediaPlayerProps) {
    const [streamUrl, setStreamUrl] = useState<string | null>(null);
    const [poster, setPoster] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    const isMobile = useIsMobile();

    // Files served by global search may live in a different channel than the
    // currently-active folder; honour the file's own folder_id when present.
    const fileFolderId: number | null =
        file.folder_id !== undefined && file.folder_id !== null ? file.folder_id : activeFolderId;

    useEffect(() => {
        let cancelled = false;
        setStreamUrl(null);
        resolveMediaUrl(fileFolderId, file.id).then((url) => {
            if (!cancelled) setStreamUrl(url);
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [file.id, fileFolderId]);

    const isVideo = isVideoFile(file.name);
    const isAudio = isAudioFile(file.name);

    useEffect(() => {
        if (!isVideo) {
            setPoster(null);
            return;
        }
        let cancelled = false;
        invoke<string>('cmd_get_thumbnail', { messageId: file.id, folderId: fileFolderId })
            .then((res) => { if (!cancelled && res) setPoster(res); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [file.id, fileFolderId, isVideo]);

    useEffect(() => {
        const el = videoRef.current ?? audioRef.current;
        if (!el) return;
        applyStoredVolume(el);
        const handler = persistVolumeHandler(el);
        el.addEventListener('volumechange', handler);
        return () => el.removeEventListener('volumechange', handler);
    }, [streamUrl, isVideo, isAudio]);

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

    if (isMobile) {
        return (
            <div className="fixed inset-0 z-[200] bg-black/95 flex flex-col items-stretch backdrop-blur-md animate-in fade-in duration-200">
                {/* Top chrome — outer wrapper owns the safe-area-inset-top
                    padding; the inner row keeps a fixed h-12 so the X tap
                    target stays full-size below the iOS status bar. The
                    previous combined element collapsed the row to a few
                    pixels on iOS PWA, making the close button untappable. */}
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

                <div className="relative flex-1 flex items-center justify-center" onClick={onClose}>
                    {onPrev && (
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onPrev(); }}
                            className="absolute left-1 top-1/2 -translate-y-1/2 p-2 bg-black/50 hover:bg-black/80 rounded-full transition-all z-10 text-white"
                            style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                            aria-label="Previous"
                        >
                            <ChevronLeft className="w-5 h-5" />
                        </button>
                    )}
                    {onNext && (
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onNext(); }}
                            className="absolute right-1 top-1/2 -translate-y-1/2 p-2 bg-black/50 hover:bg-black/80 rounded-full transition-all z-10 text-white"
                            style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                            aria-label="Next"
                        >
                            <ChevronRight className="w-5 h-5" />
                        </button>
                    )}
                    <div className="w-full h-full flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                        {!streamUrl ? (
                            <div className="flex flex-col items-center gap-4 text-white">
                                <div className="w-10 h-10 border-4 border-telegram-primary border-t-transparent rounded-full animate-spin"></div>
                                <p>Preparing stream...</p>
                            </div>
                        ) : isVideo ? (
                            <video
                                ref={videoRef}
                                src={streamUrl}
                                poster={poster ?? undefined}
                                controls
                                autoPlay
                                playsInline
                                className="max-w-full max-h-full object-contain"
                            />
                        ) : isAudio ? (
                            <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-telegram-primary/20 to-black px-6">
                                <div className="w-32 h-32 rounded-full bg-telegram-surface flex items-center justify-center mb-8 shadow-xl animate-pulse-slow">
                                    <svg xmlns="http://www.w3.org/2000/svg" className="w-12 h-12 text-telegram-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                                </div>
                                <audio ref={audioRef} src={streamUrl} controls autoPlay className="w-full max-w-md" />
                            </div>
                        ) : (
                            <div className="text-white">Unsupported media type</div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[200] bg-black/90 flex items-center justify-center p-4 backdrop-blur-md animate-in fade-in duration-200" onClick={onClose}>
            <div className="relative w-full max-w-6xl flex flex-col items-center" onClick={e => e.stopPropagation()}>
                <button
                    onClick={onPrev}
                    className="absolute left-2 top-1/2 -translate-y-1/2 p-2 text-white/50 hover:text-white bg-white/10 hover:bg-white/20 rounded-full transition-all z-10"
                    title="Previous (ArrowLeft / J)"
                >
                    <ChevronLeft className="w-6 h-6" />
                </button>

                <button
                    onClick={onNext}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-white/50 hover:text-white bg-white/10 hover:bg-white/20 rounded-full transition-all z-10"
                    title="Next (ArrowRight / L)"
                >
                    <ChevronRight className="w-6 h-6" />
                </button>

                <button
                    onClick={onClose}
                    className="absolute -top-12 right-0 p-2 text-white/50 hover:text-white bg-white/10 hover:bg-white/20 rounded-full transition-all"
                >
                    <X className="w-6 h-6" />
                </button>

                <div className="w-full aspect-video bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10 flex items-center justify-center">
                    {!streamUrl ? (
                        <div className="flex flex-col items-center gap-4 text-white">
                            <div className="w-10 h-10 border-4 border-telegram-primary border-t-transparent rounded-full animate-spin"></div>
                            <p>Preparing stream...</p>
                        </div>
                    ) : isVideo ? (
                        <video
                            ref={videoRef}
                            src={streamUrl}
                            poster={poster ?? undefined}
                            controls
                            autoPlay
                            className="w-full h-full object-contain"
                        />
                    ) : isAudio ? (
                        <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-telegram-primary/20 to-black">
                            <div className="w-32 h-32 rounded-full bg-telegram-surface flex items-center justify-center mb-8 shadow-xl animate-pulse-slow">
                                <svg xmlns="http://www.w3.org/2000/svg" className="w-12 h-12 text-telegram-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                            </div>
                            <audio ref={audioRef} src={streamUrl} controls autoPlay className="w-full max-w-md" />
                        </div>
                    ) : (
                        <div className="text-white">Unsupported media type</div>
                    )}
                </div>

                <div className="mt-4 text-center">
                    <h3 className="text-lg font-medium text-white">{file.name}</h3>
                    <p className="text-sm text-white/50">
                        Streaming from Telegram Drive
                        {typeof currentIndex === 'number' && typeof totalItems === 'number' && totalItems > 0 && (
                            <span className="ml-2">• {currentIndex + 1}/{totalItems}</span>
                        )}
                    </p>
                </div>
            </div>
        </div>
    );
}

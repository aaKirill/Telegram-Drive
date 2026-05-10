import { useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, AlertCircle, Check, X, RotateCw } from "lucide-react";
import { QueueItem, DownloadItem } from "../../types";
import { formatBytes } from "../../utils";

interface TransferQueueProps {
    uploads: QueueItem[];
    downloads: DownloadItem[];
    onClearUploads: () => void;
    onCancelAllUploads: () => void;
    onClearDownloads: () => void;
    onCancelAllDownloads: () => void;
    onDismissUpload?: (id: string) => void;
    onCancelUpload?: (id: string) => void;
    onRetryUpload?: (id: string) => void;
    onDismissDownload?: (id: string) => void;
    onCancelDownload?: (id: string) => void;
    onRetryDownload?: (id: string) => void;
}

// Single floating panel that merges Uploads + Downloads — replaces the two
// separate panels that used to overlap each other in the bottom-right
// corner. Items are listed inline with an up/down arrow distinguishing
// direction; the panel auto-dismisses 3s after every item has settled
// successfully (errors keep it open so the user sees them).
export function TransferQueue({
    uploads, downloads,
    onClearUploads, onCancelAllUploads,
    onClearDownloads, onCancelAllDownloads,
    onDismissUpload, onCancelUpload, onRetryUpload,
    onDismissDownload, onCancelDownload, onRetryDownload,
}: TransferQueueProps) {
    const total = uploads.length + downloads.length;

    const upActive = uploads.some(i => i.status === 'pending' || i.status === 'uploading');
    const dnActive = downloads.some(i => i.status === 'pending' || i.status === 'downloading');
    const anyActive = upActive || dnActive;
    const anyError = uploads.some(i => i.status === 'error') || downloads.some(i => i.status === 'error');

    // Auto-dismiss 3s after everything settles. Errors keep the panel
    // visible so the user actually sees the failure message.
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        if (total === 0 || anyActive || anyError) return;
        timerRef.current = setTimeout(() => {
            onClearUploads();
            onClearDownloads();
        }, 3000);
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = null;
        };
    }, [total, anyActive, anyError, onClearUploads, onClearDownloads]);

    if (total === 0) return null;

    const upCount = uploads.filter(i => i.status === 'pending' || i.status === 'uploading').length;
    const dnCount = downloads.filter(i => i.status === 'pending' || i.status === 'downloading').length;

    return (
        <div className="fixed bottom-4 right-4 w-80 max-w-[calc(100vw-2rem)] bg-telegram-surface border border-telegram-border rounded-xl shadow-lg overflow-hidden z-[100]">
            <div className="px-3 py-2 border-b border-telegram-border bg-telegram-hover flex justify-between items-center gap-2">
                <h4 className="text-sm font-medium text-telegram-text">Transfers</h4>
                <div className="flex items-center gap-3 text-xs">
                    {anyActive && (
                        <button
                            type="button"
                            onClick={() => { onCancelAllUploads(); onCancelAllDownloads(); }}
                            className="text-red-400 hover:text-red-300 transition-colors"
                        >
                            Cancel
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => { onClearUploads(); onClearDownloads(); }}
                        className="text-telegram-primary hover:text-telegram-text transition-colors"
                    >
                        Clear
                    </button>
                </div>
            </div>
            <div className="max-h-72 overflow-y-auto">
                {uploads.length > 0 && (
                    <Section title="Uploads" count={uploads.length} active={upCount}>
                        {uploads.map((item) => {
                            const filename = item.path.split('/').pop() ?? item.path;
                            const status = item.status === 'uploading' ? 'active' : item.status;
                            const cancellable = onCancelUpload && (item.status === 'pending' || item.status === 'uploading');
                            const retryable = onRetryUpload && (item.status === 'error' || item.status === 'cancelled');
                            const dismissable = onDismissUpload && (item.status === 'error' || item.status === 'cancelled' || item.status === 'success');
                            return (
                                <Row
                                    key={`u-${item.id}`}
                                    direction="up"
                                    filename={filename}
                                    status={status}
                                    progress={item.progress}
                                    uploadedBytes={item.uploadedBytes}
                                    totalBytes={item.totalBytes}
                                    speedBytesPerSec={item.speedBytesPerSec}
                                    error={item.error}
                                    onCancel={cancellable ? () => onCancelUpload!(item.id) : undefined}
                                    onRetry={retryable ? () => onRetryUpload!(item.id) : undefined}
                                    onDismiss={dismissable ? () => onDismissUpload!(item.id) : undefined}
                                />
                            );
                        })}
                    </Section>
                )}
                {downloads.length > 0 && (
                    <Section title="Downloads" count={downloads.length} active={dnCount}>
                        {downloads.map((item) => {
                            const status = item.status === 'downloading' ? 'active' : item.status;
                            const cancellable = onCancelDownload && (item.status === 'pending' || item.status === 'downloading');
                            const retryable = onRetryDownload && (item.status === 'error' || item.status === 'cancelled');
                            const dismissable = onDismissDownload && (item.status === 'error' || item.status === 'cancelled' || item.status === 'success');
                            return (
                                <Row
                                    key={`d-${item.id}`}
                                    direction="down"
                                    filename={item.filename}
                                    status={status}
                                    progress={item.progress}
                                    uploadedBytes={item.uploadedBytes}
                                    totalBytes={item.totalBytes}
                                    speedBytesPerSec={item.speedBytesPerSec}
                                    error={item.error}
                                    onCancel={cancellable ? () => onCancelDownload!(item.id) : undefined}
                                    onRetry={retryable ? () => onRetryDownload!(item.id) : undefined}
                                    onDismiss={dismissable ? () => onDismissDownload!(item.id) : undefined}
                                />
                            );
                        })}
                    </Section>
                )}
            </div>
        </div>
    );
}

function Section({ title, count, active, children }: { title: string; count: number; active: number; children: React.ReactNode }) {
    return (
        <div>
            <div className="px-3 py-1.5 text-[11px] font-semibold tracking-wide uppercase text-telegram-subtext bg-telegram-hover/50 flex items-center justify-between">
                <span>{title}</span>
                <span className="text-[10px] text-telegram-subtext/80 normal-case tracking-normal">
                    {active > 0 ? `${active} active · ${count} total` : `${count}`}
                </span>
            </div>
            <div className="p-2 space-y-1.5">{children}</div>
        </div>
    );
}

function Row({ direction, filename, status, progress, uploadedBytes, totalBytes, speedBytesPerSec, error, onCancel, onRetry, onDismiss }: {
    direction: 'up' | 'down';
    filename: string;
    status: 'pending' | 'active' | 'success' | 'error' | 'cancelled';
    progress?: number;
    uploadedBytes?: number;
    totalBytes?: number;
    speedBytesPerSec?: number;
    error?: string;
    onCancel?: () => void;
    onRetry?: () => void;
    onDismiss?: () => void;
}) {
    const showBytes = status === 'active' && totalBytes !== undefined && totalBytes > 0;
    return (
        <div className="flex flex-col gap-1 p-2 bg-telegram-hover rounded">
            <div className="flex items-center gap-2 text-sm">
                <StatusDot status={status} direction={direction} />
                <div className="flex-1 truncate text-telegram-subtext" title={filename}>
                    {filename}
                </div>
                {status === 'active' && progress !== undefined && (
                    <div className="text-xs font-mono text-telegram-subtext">{progress}%</div>
                )}
                {status === 'cancelled' && <div className="text-xs text-gray-400">Cancelled</div>}
                {status === 'error' && <div className="text-xs text-red-400">Error</div>}
                {onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="flex-shrink-0 p-0.5 rounded text-telegram-subtext hover:text-telegram-primary hover:bg-telegram-border transition-colors"
                        title="Retry"
                    >
                        <RotateCw className="w-3.5 h-3.5" />
                    </button>
                )}
                {onCancel && (
                    <button
                        type="button"
                        onClick={onCancel}
                        className="flex-shrink-0 p-0.5 rounded text-telegram-subtext hover:text-red-400 hover:bg-telegram-border transition-colors"
                        title="Cancel"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                )}
                {onDismiss && (
                    <button
                        type="button"
                        onClick={onDismiss}
                        className="flex-shrink-0 p-0.5 rounded text-telegram-subtext hover:text-telegram-text hover:bg-telegram-border transition-colors"
                        title="Dismiss"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>
            {status === 'active' && (
                <div className="w-full bg-telegram-border h-1 rounded-full overflow-hidden">
                    {progress !== undefined ? (
                        <div
                            className={`h-full rounded-full transition-all duration-300 ${direction === 'up' ? 'bg-blue-500' : 'bg-telegram-secondary'}`}
                            style={{ width: `${progress}%` }}
                        />
                    ) : (
                        <div className={`h-full w-full animate-progress-indeterminate ${direction === 'up' ? 'bg-blue-500' : 'bg-telegram-secondary'}`} />
                    )}
                </div>
            )}
            {showBytes && (
                <div className="flex items-center gap-2 text-[11px] font-mono text-telegram-subtext">
                    <span>{formatBytes(uploadedBytes ?? 0)} / {formatBytes(totalBytes!)}</span>
                    {speedBytesPerSec !== undefined && speedBytesPerSec > 0 && (
                        <span className="text-telegram-subtext/70">· {formatBytes(speedBytesPerSec)}/s</span>
                    )}
                </div>
            )}
            {status === 'error' && error && (
                <div className="flex items-center gap-1 text-xs text-red-400 mt-0.5">
                    <AlertCircle className="w-3 h-3 shrink-0" />
                    <span className="truncate">{error}</span>
                </div>
            )}
        </div>
    );
}

function StatusDot({ status, direction }: { status: 'pending' | 'active' | 'success' | 'error' | 'cancelled'; direction: 'up' | 'down' }) {
    const Arrow = direction === 'up' ? ArrowUp : ArrowDown;
    if (status === 'pending') return <div className="w-4 h-4 rounded-full bg-yellow-500/20 flex items-center justify-center"><Arrow className="w-2.5 h-2.5 text-yellow-500" /></div>;
    if (status === 'active') return <div className="w-4 h-4 rounded-full bg-telegram-primary/20 flex items-center justify-center"><Arrow className="w-2.5 h-2.5 text-telegram-primary animate-pulse" /></div>;
    if (status === 'success') return <div className="w-4 h-4 rounded-full bg-green-500/20 flex items-center justify-center"><Check className="w-3 h-3 text-green-500" /></div>;
    if (status === 'error') return <div className="w-4 h-4 rounded-full bg-red-500/20 flex items-center justify-center"><X className="w-3 h-3 text-red-500" /></div>;
    return <div className="w-4 h-4 rounded-full bg-gray-500/20 flex items-center justify-center"><X className="w-3 h-3 text-gray-400" /></div>;
}

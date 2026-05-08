export function formatBytes(bytes: number, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// ── File type classification ────────────────────────────────────────────

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogv', 'mov', 'mkv', 'avi'] as const;
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'aac', 'flac', 'm4a', 'opus', 'ogg', 'oga'] as const;
const MEDIA_EXTENSIONS: readonly string[] = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif'] as const;

const endsWithAny = (name: string, exts: readonly string[]) => {
    const lower = name.toLowerCase();
    return exts.some(ext => lower.endsWith(ext));
};

const DOCUMENT_EXTENSIONS = ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp', 'epub', 'pages', 'numbers', 'key'] as const;

export const isMediaFile    = (name: string) => endsWithAny(name, MEDIA_EXTENSIONS);
export const isVideoFile    = (name: string) => endsWithAny(name, VIDEO_EXTENSIONS);
export const isAudioFile    = (name: string) => endsWithAny(name, AUDIO_EXTENSIONS);
export const isImageFile    = (name: string) => endsWithAny(name, IMAGE_EXTENSIONS);
export const isPdfFile      = (name: string) => name.toLowerCase().endsWith('.pdf');
export const isDocumentFile = (name: string) => endsWithAny(name, DOCUMENT_EXTENSIONS);

export type FileTypeCategory = 'all' | 'image' | 'video' | 'audio' | 'document' | 'other';

export function categorizeFile(name: string): Exclude<FileTypeCategory, 'all'> {
    if (isImageFile(name)) return 'image';
    if (isVideoFile(name)) return 'video';
    if (isAudioFile(name)) return 'audio';
    if (isDocumentFile(name)) return 'document';
    return 'other';
}

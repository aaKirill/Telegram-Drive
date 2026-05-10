export interface TelegramFile {
    id: number;
    name: string;
    size: number;
    sizeStr: string; // Formatted size
    /** Channel/peer the message lives in. Comes through as snake_case from
     *  the Rust backend (FileMetadata serde derive without rename_all).
     *  May differ from the dashboard's `activeFolderId` when files come
     *  from a global search across [TD] channels — always pair with
     *  `?? activeFolderId` to fall back to the current view. */
    folder_id?: number | null;
    created_at?: string;
    type?: 'folder' | 'file'; // implied icon_type
    /** Video duration in seconds — set for video documents on both web
     *  (extracted in mapMessageToFile) and desktop (commands/fs.rs).
     *  Used by FileCard to render the iOS-Photos time pill. */
    duration_secs?: number | null;
    // Add other fields if backend sends them
}

export interface TelegramFolder {
    id: number;
    name: string;
    parent_id?: number;
}

export interface QueueItem {
    id: string;
    path: string;
    folderId: number | null;
    status: 'pending' | 'uploading' | 'success' | 'error' | 'cancelled';
    error?: string;
    progress?: number; // 0-100
}

export interface BandwidthStats {
    up_bytes: number;
    down_bytes: number;
}

export interface DownloadItem {
    id: string;
    messageId: number;
    filename: string;
    folderId: number | null;
    status: 'pending' | 'downloading' | 'success' | 'error' | 'cancelled';
    error?: string;
    progress?: number; // 0-100
}

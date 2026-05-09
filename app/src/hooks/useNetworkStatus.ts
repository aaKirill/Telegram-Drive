import { useState, useEffect } from 'react';
import { invoke } from '../lib/transport';

export function useNetworkStatus() {
    const [isOnline, setIsOnline] = useState(true);

    useEffect(() => {
        const checkNetwork = async () => {
            try {
                const available = await invoke<boolean>('cmd_is_network_available');
                setIsOnline(available);
            } catch {
                setIsOnline(false);
            }
        };
        checkNetwork();
        const interval = setInterval(checkNetwork, 10000);
        return () => clearInterval(interval);
    }, []);

    return isOnline;
}

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Settings } from '../components/Settings';
import { AuthProvider } from '../context/AuthContext';
import { NCCProvider } from '../context/NCCContext';
import { RelayManager } from '../lib/relays';

// Mock nostr-tools
const { mockQuerySync, mockGet } = vi.hoisted(() => ({
    mockQuerySync: vi.fn().mockReturnValue([]),
    mockGet: vi.fn().mockReturnValue(null),
}));

vi.mock('nostr-tools', async () => {
    const actual = await vi.importActual('nostr-tools');
    return {
        ...actual,
        SimplePool: class {
            querySync = mockQuerySync;
            get = mockGet;
        }
    };
});

// Mock NCC Context and Auth Context
const mockResolve = vi.fn();
vi.mock('../context/NCCContext', () => ({
    useNCC: () => ({
        pool: { 
            querySync: mockQuerySync,
            get: mockGet,
            publish: vi.fn().mockResolvedValue({})
        },
        ncc05Resolver: { resolve: mockResolve }
    }),
    NCCProvider: ({ children }: any) => <>{children}</>
}));

vi.mock('../context/AuthContext', () => ({
    useAuth: () => ({
        pubkey: 'session-pubkey',
        privkey: null,
        method: 'nip07'
    }),
    AuthProvider: ({ children }: any) => <>{children}</>
}));

// Mock RelayManager
vi.mock('../lib/relays', async () => {
    const actual = await vi.importActual('../lib/relays');
    return {
        ...actual,
        RelayManager: {
            load: vi.fn().mockReturnValue(['wss://relay.damus.io']),
            add: vi.fn(),
            save: vi.fn(),
            remove: vi.fn(),
            restoreDefaults: vi.fn()
        }
    };
});

describe('Settings Component - Relay Resolution', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.alert = vi.fn();
        // @ts-ignore
        window.nostr = {
            nip44: {
                decrypt: vi.fn().mockResolvedValue('{"endpoints": [{"url": "ws://xyz.onion"}]}')
            }
        };
    });

    it('resolves an npub and adds it to the bootstrap list', async () => {
        // Mock finding a public NCC-02 record
        mockQuerySync.mockResolvedValue([
            {
                kind: 30059,
                pubkey: 'deadbeef',
                created_at: 1000,
                tags: [['d', 'relay'], ['u', 'wss://new.relay']]
            }
        ]);

        render(
            <AuthProvider>
                <NCCProvider>
                    <Settings />
                </NCCProvider>
            </AuthProvider>
        );

        const input = screen.getByPlaceholderText(/wss:\/\/... or npub1.../i);
        const addButton = screen.getByText(/Add/i);

        fireEvent.change(input, { target: { value: 'npub10pt7v2yl9636wp269v' } });
        fireEvent.click(addButton);

        await waitFor(() => {
            expect(RelayManager.add).toHaveBeenCalledWith('wss://new.relay');
        }, { timeout: 3000 });
    });

    it('automatically bridges resolved onion relays', async () => {
        // Mock finding a locator with an onion address
        mockQuerySync.mockResolvedValue([
            {
                kind: 30058,
                pubkey: 'deadbeef',
                content: '{}',
                created_at: 1000,
                tags: [['d', 'relay']]
            }
        ]);

        mockResolve.mockResolvedValue({
            endpoints: [{ url: 'ws://xyz.onion', priority: 1 }]
        });

        render(
            <AuthProvider>
                <NCCProvider>
                    <Settings />
                </NCCProvider>
            </AuthProvider>
        );

        const input = screen.getByPlaceholderText(/wss:\/\/... or npub1.../i);
        const addButton = screen.getByText(/Add/i);

        fireEvent.change(input, { target: { value: 'npub10pt7v2yl9636wp269v' } });
        fireEvent.click(addButton);

        await waitFor(() => {
            // Check that it was called with a bridged URL
            const call = vi.mocked(RelayManager.add).mock.calls[0][0];
            expect(call).toContain('target=ws%3A%2F%2Fxyz.onion');
        }, { timeout: 3000 });
    });
});

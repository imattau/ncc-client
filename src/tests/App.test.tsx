import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Discovery } from '../components/Discovery';
import { Feed } from '../components/Feed';
import { NCCProvider } from '../context/NCCContext';
import { AuthProvider } from '../context/AuthContext';
import { TrackingProvider } from '../context/TrackingContext';

// Hoist mocks to ensure they are available before imports
const { mockResolve02, mockResolve05, mockQuerySync, mockSubscribeMany, mockConnect } = vi.hoisted(() => {
    return {
        mockResolve02: vi.fn(),
        mockResolve05: vi.fn(),
        mockQuerySync: vi.fn().mockReturnValue([]),
        mockSubscribeMany: vi.fn().mockReturnValue({ close: vi.fn() }),
        mockConnect: vi.fn().mockResolvedValue({ close: vi.fn() })
    };
});

// Mock nostr-tools
vi.mock('nostr-tools', async () => {
  const actual = await vi.importActual('nostr-tools');
  return {
    ...actual,
    SimplePool: class MockSimplePool {
        querySync = mockQuerySync;
        subscribeMany = mockSubscribeMany;
        close = vi.fn();
    },
    Relay: {
        connect: mockConnect
    },
    nip44: {
        getConversationKey: vi.fn().mockReturnValue(new Uint8Array(32)),
        decrypt: vi.fn().mockReturnValue('{"endpoints": [{"url": "wss://test.relay"}]}'),
    }
  };
});

// Mock NCC Resolver (since we use it in Discovery)
vi.mock('../context/NCCContext', async () => {
    const actual = await vi.importActual('../context/NCCContext');
    return {
        ...actual,
        useNCC: () => ({
            ncc02Resolver: { resolve: mockResolve02, relays: [] },
            ncc05Resolver: { resolve: mockResolve05, bootstrapRelays: [] },
            pool: { 
                querySync: mockQuerySync,
                subscribeMany: mockSubscribeMany
            }
        })
    };
});

describe('Feed Component', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset default mock returns
        mockQuerySync.mockReturnValue([]);
        mockConnect.mockResolvedValue({ close: vi.fn() });
    });

    it('shows disconnected state initially', () => {
        render(<Feed relayUrl={null} />);
        expect(screen.getByText(/No Relay Connected/i)).toBeInTheDocument();
    });

    it('attempts connection when url provided', async () => {
        render(<Feed relayUrl="wss://test.relay" />);
        expect(screen.getByText(/wss:\/\/test.relay/i)).toBeInTheDocument();
        // Since we mocked Relay.connect to resolve, it should show 'connecting' or connected eventually
        // But our component updates state async.
    });

    it('fails fast for onion addresses', async () => {
        render(<Feed relayUrl="ws://test.onion" />);
        await waitFor(() => {
            expect(screen.getByText(/Browsers cannot connect to .onion/i)).toBeInTheDocument();
        });
    });
});

describe('Discovery Component', () => {
    const mockOnConnect = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        mockQuerySync.mockReturnValue([]);
    });

    it('renders input fields', () => {
        render(
            <AuthProvider>
                <TrackingProvider>
                    <Discovery onConnect={mockOnConnect} />
                </TrackingProvider>
            </AuthProvider>
        );
        expect(screen.getByPlaceholderText(/npub1.../i)).toBeInTheDocument();
        expect(screen.getByPlaceholderText(/e.g. relay/i)).toBeInTheDocument();
    });

    it('triggers global search when pubkey is empty', async () => {
        render(
            <AuthProvider>
                <TrackingProvider>
                    <Discovery onConnect={mockOnConnect} />
                </TrackingProvider>
            </AuthProvider>
        );
        
        const button = screen.getByText('Run Discovery');
        fireEvent.click(button);

        await waitFor(() => {
            expect(screen.getByText(/Global Search/i)).toBeInTheDocument();
        });
    });
});

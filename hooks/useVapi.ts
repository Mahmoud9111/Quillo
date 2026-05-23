'use client';

// Create hooks/useVapi.ts: the core hook. Initializes Vapi SDK, manages call lifecycle (idle, connecting, starting, listening, thinking, speaking), tracks messages array + currentMessage streaming, handles duration timer with maxDuration enforcement, session tracking via server actions

import { useState, useEffect, useRef, useCallback } from 'react';
import Vapi from '@vapi-ai/web';
import { useAuth } from '@clerk/nextjs';

import { ASSISTANT_ID, DEFAULT_VOICE, VOICE_SETTINGS } from '@/lib/constants';
import { getVoice } from '@/lib/utils';
import { IBook, Messages } from '@/types';
import { startVoiceSession, endVoiceSession } from '@/lib/actions/session.actions';

export function useLatestRef<T>(value: T) {
    const ref = useRef(value);

    useEffect(() => {
        ref.current = value;
    }, [value]);

    return ref;
}

const VAPI_API_KEY = process.env.NEXT_PUBLIC_VAPI_API_KEY;
const TIMER_INTERVAL_MS = 1000;
const SECONDS_PER_MINUTE = 60;
const TIME_WARNING_THRESHOLD = 60; // Show warning when this many seconds remain

let vapi: InstanceType<typeof Vapi>;
function getVapi() {
    if (!vapi) {
        if (!VAPI_API_KEY) {
            throw new Error('NEXT_PUBLIC_VAPI_API_KEY environment variable is not set');
        }
        vapi = new Vapi(VAPI_API_KEY);
    }
    return vapi;
}

export type CallStatus = 'idle' | 'connecting' | 'starting' | 'listening' | 'thinking' | 'speaking';

const MAX_SESSION_MINUTES = 60;

export function useVapi(book: IBook) {
    const { userId } = useAuth();

    const [status, setStatus] = useState<CallStatus>('idle');
    const [messages, setMessages] = useState<Messages[]>([]);
    const [currentMessage, setCurrentMessage] = useState('');
    const [currentUserMessage, setCurrentUserMessage] = useState('');
    const [duration, setDuration] = useState(0);
    const [limitError, setLimitError] = useState<string | null>(null);

    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const startTimeRef = useRef<number | null>(null);
    const sessionIdRef = useRef<string | null>(null);
    const isStoppingRef = useRef(false);
    const connectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const maxDurationSeconds = MAX_SESSION_MINUTES * 60;
    const maxDurationRef = useLatestRef(maxDurationSeconds);
    const durationRef = useLatestRef(duration);
    const voice = book.persona || DEFAULT_VOICE;

    // Set up Vapi event listeners
    useEffect(() => {
        const handlers = {
            'call-start': () => {
                isStoppingRef.current = false;
                if (connectTimeoutRef.current) {
                    clearTimeout(connectTimeoutRef.current);
                    connectTimeoutRef.current = null;
                }
                setStatus('starting'); // AI speaks first, wait for it
                setCurrentMessage('');
                setCurrentUserMessage('');

                // Start duration timer
                startTimeRef.current = Date.now();
                setDuration(0);
                timerRef.current = setInterval(() => {
                    if (startTimeRef.current) {
                        const newDuration = Math.floor((Date.now() - startTimeRef.current) / TIMER_INTERVAL_MS);
                        setDuration(newDuration);

                        // Check duration limit
                        if (newDuration >= maxDurationRef.current) {
                            getVapi().stop();
                            setLimitError(
                                `Session time limit (${Math.floor(
                                    maxDurationRef.current / SECONDS_PER_MINUTE,
                                )} minutes) reached.`,
                            );
                        }
                    }
                }, TIMER_INTERVAL_MS);
            },

            'call-end': () => {
                // Don't reset isStoppingRef here - delayed events may still fire
                setStatus('idle');
                setCurrentMessage('');
                setCurrentUserMessage('');

                // Stop timer
                if (timerRef.current) {
                    clearInterval(timerRef.current);
                    timerRef.current = null;
                }

                // End session tracking
                if (sessionIdRef.current) {
                    endVoiceSession(sessionIdRef.current, durationRef.current).catch((err) =>
                        console.warn('Failed to end voice session:', err),
                    );
                    sessionIdRef.current = null;
                }

                startTimeRef.current = null;
            },

            'speech-start': () => {
                if (!isStoppingRef.current) {
                    setStatus('speaking');
                }
            },
            'speech-end': () => {
                if (!isStoppingRef.current) {
                    // After AI finishes speaking, user can talk
                    setStatus('listening');
                }
            },

            message: (message: {
                type: string;
                role: string;
                transcriptType: string;
                transcript: string;
            }) => {
                if (message.type !== 'transcript') return;

                // User finished speaking → AI is thinking
                if (message.role === 'user' && message.transcriptType === 'final') {
                    if (!isStoppingRef.current) {
                        setStatus('thinking');
                    }
                    setCurrentUserMessage('');
                }

                // Partial user transcript → show real-time typing
                if (message.role === 'user' && message.transcriptType === 'partial') {
                    setCurrentUserMessage(message.transcript);
                    return;
                }

                // Partial AI transcript → show word-by-word
                if (message.role === 'assistant' && message.transcriptType === 'partial') {
                    setCurrentMessage(message.transcript);
                    return;
                }

                // Final transcript → add to messages
                if (message.transcriptType === 'final') {
                    if (message.role === 'assistant') setCurrentMessage('');
                    if (message.role === 'user') setCurrentUserMessage('');

                    setMessages((prev) => {
                        const isDupe = prev.some(
                            (m) => m.role === message.role && m.content === message.transcript,
                        );
                        return isDupe ? prev : [...prev, { role: message.role, content: message.transcript }];
                    });
                }
            },

            error: (error: unknown) => {
                // Vapi can emit Errors, plain objects, or nested shapes like
                // { error: { type, msg }, action, errorMsg }. Extract a readable string.
                const extractMessage = (e: unknown): string => {
                    if (!e) return '';
                    if (typeof e === 'string') return e;
                    if (e instanceof Error) return e.message;
                    if (typeof e === 'object') {
                        const obj = e as Record<string, unknown>;
                        const nested =
                            (obj.errorMsg as string) ||
                            (obj.message as string) ||
                            (obj.msg as string) ||
                            (typeof obj.error === 'object' ? extractMessage(obj.error) : (obj.error as string)) ||
                            (obj.type as string) ||
                            '';
                        return nested;
                    }
                    return '';
                };

                const errorMessage = extractMessage(error);
                // Use warn (not error) so Next.js dev overlay doesn't surface it as "Unhandled error"
                try {
                    console.warn(
                        'Vapi error:',
                        errorMessage || '(no message)',
                        JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})),
                    );
                } catch {
                    console.warn('Vapi error (unserializable):', errorMessage || '(no message)');
                }

                // Empty error object often fires right after a normal stop — ignore it
                if (!errorMessage && isStoppingRef.current) {
                    return;
                }

                setStatus('idle');
                setCurrentMessage('');
                setCurrentUserMessage('');

                if (timerRef.current) {
                    clearInterval(timerRef.current);
                    timerRef.current = null;
                }
                if (connectTimeoutRef.current) {
                    clearTimeout(connectTimeoutRef.current);
                    connectTimeoutRef.current = null;
                }

                if (sessionIdRef.current) {
                    endVoiceSession(sessionIdRef.current, durationRef.current).catch((err) =>
                        console.warn('Failed to end voice session on error:', err),
                    );
                    sessionIdRef.current = null;
                }

                const lower = errorMessage.toLowerCase();
                if (lower.includes('failed to fetch') || lower.includes('start-method-error')) {
                    setLimitError(
                        'Cannot reach voice servers (api.vapi.ai). Disable ad blockers/VPN for this site, or try an incognito window.',
                    );
                } else if (lower.includes('timeout') || lower.includes('silence')) {
                    setLimitError('Session ended due to inactivity. Click the mic to start again.');
                } else if (lower.includes('network') || lower.includes('connection') || lower.includes('ejected')) {
                    setLimitError('Connection lost. Please check your internet and try again.');
                } else if (lower.includes('meeting') || lower.includes('room')) {
                    setLimitError('Voice room ended. Click the mic to start again.');
                } else {
                    setLimitError('Session ended unexpectedly. Click the mic to start again.');
                }

                startTimeRef.current = null;
            },
        };

        // Register all handlers
        Object.entries(handlers).forEach(([event, handler]) => {
            getVapi().on(event as keyof typeof handlers, handler as () => void);
        });

        return () => {
            // End active session on unmount
            if (sessionIdRef.current) {
                getVapi().stop();
                endVoiceSession(sessionIdRef.current, durationRef.current).catch((err) =>
                    console.warn('Failed to end voice session on unmount:', err),
                );
                sessionIdRef.current = null;
            }
            // Cleanup handlers
            Object.entries(handlers).forEach(([event, handler]) => {
                getVapi().off(event as keyof typeof handlers, handler as () => void);
            });
            if (timerRef.current) clearInterval(timerRef.current);
            if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
        };
    }, []);

    const start = useCallback(async () => {
        if (!userId) {
            setLimitError('Please sign in to start a voice session.');
            return;
        }

        setLimitError(null);
        setStatus('connecting');

        try {
            const result = await startVoiceSession(userId, book._id);

            if (!result.success) {
                setLimitError(result.error || 'Failed to start voice session.');
                setStatus('idle');
                return;
            }

            sessionIdRef.current = result.sessionId || null;

            const firstMessage = `Hey, good to meet you. Quick question before we dive in - have you actually read ${book.title} yet, or are we starting fresh?`;

            // Fail fast if call-start hasn't fired within 20s — Vapi's internal retry can otherwise hang ~60s
            connectTimeoutRef.current = setTimeout(() => {
                if (sessionIdRef.current) {
                    try { getVapi().stop(); } catch { /* no active call */ }
                    endVoiceSession(sessionIdRef.current, 0).catch(() => {});
                    sessionIdRef.current = null;
                }
                setStatus('idle');
                setLimitError(
                    'Cannot reach voice servers (api.vapi.ai). Disable ad blockers/VPN for this site, or try an incognito window.',
                );
            }, 20000);

            // Vapi can reject with undefined on network failures — catch directly so the unhandled
            // rejection doesn't reach Next.js's dev overlay as "Unhandled error. (undefined)".
            await getVapi()
                .start(ASSISTANT_ID, {
                    firstMessage,
                    variableValues: {
                        title: book.title,
                        author: book.author,
                        bookId: book._id,
                    },
                    voice: {
                        provider: '11labs' as const,
                        voiceId: getVoice(voice).id,
                        model: 'eleven_turbo_v2_5' as const,
                        stability: VOICE_SETTINGS.stability,
                        similarityBoost: VOICE_SETTINGS.similarityBoost,
                        style: VOICE_SETTINGS.style,
                        useSpeakerBoost: VOICE_SETTINGS.useSpeakerBoost,
                    },
                })
                .catch((err: unknown) => {
                    const msg =
                        err instanceof Error
                            ? err.message
                            : err && typeof err === 'object' && 'message' in err
                              ? String((err as { message: unknown }).message)
                              : err
                                ? String(err)
                                : '';
                    console.warn('Vapi start failed:', msg || '(empty rejection — likely network)');
                    throw new Error(msg || 'failed to fetch');
                });
        } catch (err) {
            if (connectTimeoutRef.current) {
                clearTimeout(connectTimeoutRef.current);
                connectTimeoutRef.current = null;
            }
            setStatus('idle');
            const msg = err instanceof Error ? err.message : String(err);
            const lower = msg.toLowerCase();
            if (!msg || lower.includes('failed to fetch') || lower.includes('network')) {
                setLimitError(
                    'Cannot reach voice servers (api.vapi.ai). Disable ad blockers/VPN for this site, or try an incognito window.',
                );
            } else {
                setLimitError('Failed to start voice session. Please try again.');
            }
        }
    }, [book._id, book.title, book.author, voice, userId]);

    const stop = useCallback(() => {
        isStoppingRef.current = true;
        if (connectTimeoutRef.current) {
            clearTimeout(connectTimeoutRef.current);
            connectTimeoutRef.current = null;
        }
        getVapi().stop();
    }, []);

    const clearError = useCallback(() => {
        setLimitError(null);
    }, []);

    const isActive =
        status === 'starting' ||
        status === 'listening' ||
        status === 'thinking' ||
        status === 'speaking';

    return {
        status,
        isActive,
        messages,
        currentMessage,
        currentUserMessage,
        duration,
        start,
        stop,
        limitError,
        maxDurationSeconds,
        clearError,
    };
}

export default useVapi;

import {useState, useEffect, useRef, useCallback} from 'react';
import {logger} from '@/lib/logger';
import {GameConfig} from '@/config';
import {useGameMutations} from './useGameMutations';
import type {User} from '@features/auth';
import {toDecimal} from '@/lib/decimal';
import {emitCandyUpdate} from '@/lib/candyEvents';

interface UseCandySyncProps {
  user: User | null;
  isAuthenticated: boolean;
  updateUser: (user: User) => void;
}

/**
 * Manages local candy state with time-based batched server syncing
 * Implements optimistic updates with automatic retry on failure
 *
 * Sync strategy:
 * - Maintains local candy count that updates immediately (optimistic)
 * - Accumulates changes in unsyncedAmount buffer
 * - Flushes to server when:
 *   1. Time threshold reached (default: 30 seconds after first candy addition)
 *   2. Component unmounts (navigating away from clicker page)
 *   3. Manual flush before upgrades (to ensure sufficient candy)
 *   4. Before logout (via registerBeforeLogout in CandyProvider)
 *
 * Persistence:
 * - On page refresh/close, unsynced amount is saved to localStorage
 * - On next mount for the same user, the pending amount is recovered and re-queued
 *
 * Error handling:
 * - If sync fails, adds amount back to unsynced buffer
 * - Automatically retries on next flush trigger
 * - Shows temporary error message to user
 *
 * Why time-based batching?
 * - Predictable sync intervals prevent rate limiting
 * - Reduces server load (max 2 requests/minute)
 * - Improves performance (no waiting for server on each click)
 * - Prevents race conditions with rapid clicking and autoclicker
 *
 * @param user - Current authenticated user
 * @param isAuthenticated - Must be true to sync candy to server
 * @param updateUser - Callback to update user context after successful sync
 */
export function useCandySync({
  user,
  isAuthenticated,
  updateUser,
}: UseCandySyncProps) {
  const {updateRareCandy} = useGameMutations();

  const [localRareCandy, setLocalRareCandy] = useState(
    user?.rare_candy ? String(user.rare_candy) : '0'
  );
  const [unsyncedAmount, setUnsyncedAmount] = useState('0');
  const unsyncedAmountRef = useRef('0');
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncRef = useRef<number>(Date.now());
  const [displayError, setDisplayError] = useState<string | null>(null);

  // Track current user ID via ref so beforeunload handler always has the latest value
  const userIdRef = useRef<string | undefined>(user?._id);
  useEffect(() => {
    userIdRef.current = user?._id;
  }, [user?._id]);

  // Reset local state whenever the server user object changes (e.g. after updateUser calls)
  useEffect(() => {
    if (!user) return;

    const nextValue = String(user.rare_candy ?? '0');
    setLocalRareCandy(nextValue);
    setUnsyncedAmount('0');
    unsyncedAmountRef.current = '0';

    // Defer event emission to avoid updating other components during render
    // This prevents "Cannot update a component while rendering a different component" error
    queueMicrotask(() => {
      emitCandyUpdate(nextValue);
    });
  }, [user]);

  // Recover any candy that was pending when the page was refreshed/closed.
  // This effect intentionally runs AFTER the user reset effect above so the
  // pending amount is added on top of the freshly-reset DB value.
  useEffect(() => {
    if (!user?._id) return;
    const key = `pendingCandy_${user._id}`;
    const pending = localStorage.getItem(key);
    if (pending && toDecimal(pending).gt(0)) {
      localStorage.removeItem(key);
      setUnsyncedAmount(pending);
      unsyncedAmountRef.current = pending;
      setLocalRareCandy((prev) => {
        const next = toDecimal(prev).plus(pending).toString();
        queueMicrotask(() => emitCandyUpdate(next));
        return next;
      });
    }
    // Only run when the user ID changes (i.e. a different user logs in or initial load)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?._id]);

  // On page refresh or close, save any unsynced candy to localStorage so it
  // can be recovered on the next session for the same user.
  useEffect(() => {
    const handleBeforeUnload = () => {
      const userId = userIdRef.current;
      const pending = unsyncedAmountRef.current;
      if (userId && toDecimal(pending).gt(0)) {
        localStorage.setItem(`pendingCandy_${userId}`, pending);
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  /**
   * Flushes accumulated candy changes to the server
   * Called automatically by triggers or manually before upgrades
   */
  const flushPendingCandy = useCallback(async () => {
    if (toDecimal(unsyncedAmount).eq(0) || !isAuthenticated) return;

    // Snapshot the amount to sync and clear buffer immediately
    const amountToSync = unsyncedAmount;
    setUnsyncedAmount('0');
    unsyncedAmountRef.current = '0';
    lastSyncRef.current = Date.now();

    // Clear any pending batch timer
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }

    try {
      await updateRareCandy(amountToSync, updateUser);
      // Clear any persisted pending candy for this user (covers the refresh-recovery case)
      if (userIdRef.current) {
        localStorage.removeItem(`pendingCandy_${userIdRef.current}`);
      }
    } catch (err) {
      // On failure, add the amount back to unsynced buffer for retry
      logger.logError(err, 'SyncCandy');
      setDisplayError('Failed to save progress. Will retry...');
      setUnsyncedAmount((prev) => {
        const newAmount = toDecimal(prev).plus(amountToSync).toString();
        unsyncedAmountRef.current = newAmount;
        return newAmount;
      });
      setTimeout(
        () => setDisplayError(null),
        GameConfig.clicker.errorDisplayDuration
      );
    }
  }, [unsyncedAmount, isAuthenticated, updateRareCandy, updateUser]);

  // Auto-flush effect: Time-based batching only (no click threshold)
  // Timer starts when first candy is added, flushes after time threshold
  useEffect(() => {
    if (toDecimal(unsyncedAmount).eq(0) || !isAuthenticated) {
      // Clear timer if no candy to sync
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      return;
    }

    // Only start timer if not already running
    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(() => {
        flushPendingCandy();
        batchTimerRef.current = null;
      }, GameConfig.clicker.batchSyncTimeThreshold);
    }

    return () => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
    };
  }, [unsyncedAmount, isAuthenticated, flushPendingCandy]);

  const flushPendingCandyRef = useRef(flushPendingCandy);
  useEffect(() => {
    flushPendingCandyRef.current = flushPendingCandy;
  }, [flushPendingCandy]);

  // Flush on unmount: Ensures candy is saved when navigating away from clicker
  // Empty deps - we want this to run ONLY on unmount, refs handle current values
  useEffect(() => {
    return () => {
      if (toDecimal(unsyncedAmountRef.current).gt(0)) {
        flushPendingCandyRef.current();
      }
    };
  }, []);

  /**
   * Adds candy to local state and unsynced buffer
   * Updates are optimistic - shown immediately to user
   */
  const addCandy = useCallback((amount: string) => {
    setLocalRareCandy((prev) => {
      const next = toDecimal(prev).plus(amount).toString();
      // Defer event emission to avoid updating other components during render
      queueMicrotask(() => {
        emitCandyUpdate(next);
      });
      return next;
    });
    setUnsyncedAmount((prev) => {
      const newAmount = toDecimal(prev).plus(amount).toString();
      unsyncedAmountRef.current = newAmount;
      return newAmount;
    });
  }, []);

  /**
   * Deducts candy from local state immediately (for upgrades)
   * Does NOT add to unsynced buffer since upgrades sync separately
   */
  const deductCandy = useCallback((amount: string) => {
    setLocalRareCandy((prev) => {
      const next = toDecimal(prev).minus(amount).toString();
      // Defer event emission to avoid updating other components during render
      queueMicrotask(() => {
        emitCandyUpdate(next);
      });
      return next;
    });
  }, []);

  return {
    localRareCandy,
    unsyncedAmount,
    displayError,
    setDisplayError,
    addCandy,
    deductCandy,
    flushPendingCandy,
  };
}

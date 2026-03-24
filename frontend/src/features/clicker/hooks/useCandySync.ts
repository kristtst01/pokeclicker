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
}

/**
 * Manages local candy state with time-based batched server syncing
 * Implements optimistic updates with automatic retry on failure
 *
 * Architecture:
 * - localRareCandy is the SOURCE OF TRUTH for display during a session
 * - It is only reset from the server on login (user._id changes)
 * - All mutations (flush, purchases, upgrades, catches) may update the user
 *   object in AuthContext, but those changes do NOT reset localRareCandy
 * - This eliminates race conditions where in-flight mutations overwrite
 *   candy earned between the flush start and the server response
 *
 * Sync strategy:
 * - Accumulates changes in unsyncedAmount buffer
 * - Flushes to server when:
 *   1. Time threshold reached (default: 30 seconds after first candy addition)
 *   2. Component unmounts (navigating away from clicker page)
 *   3. Manual flush before upgrades/purchases (to ensure sufficient candy)
 *   4. Before logout (via registerBeforeLogout in CandyProvider)
 *
 * Persistence:
 * - On page refresh/close, unsynced amount is saved to localStorage
 * - On next mount for the same user, the pending amount is recovered
 *
 * @param user - Current authenticated user
 * @param isAuthenticated - Must be true to sync candy to server
 */
export function useCandySync({user, isAuthenticated}: UseCandySyncProps) {
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

  // Reset local candy state ONLY on login/logout (when user identity changes).
  // Other user object updates (from mutations like catchPokemon, purchasePokemon,
  // upgradeStat, etc.) do NOT reset localRareCandy — it is the source of truth
  // during a session and is only modified via addCandy/deductCandy.
  //
  // Also recovers any pending candy saved to localStorage before a page refresh.
  useEffect(() => {
    if (!user?._id) return;

    const serverCandy = String(user.rare_candy ?? '0');
    setUnsyncedAmount('0');
    unsyncedAmountRef.current = '0';

    // Check for pending candy saved before a page refresh
    const key = `pendingCandy_${user._id}`;
    const saved = localStorage.getItem(key);
    let nextValue = serverCandy;
    if (saved && toDecimal(saved).gt(0)) {
      localStorage.removeItem(key);
      setUnsyncedAmount(saved);
      unsyncedAmountRef.current = saved;
      nextValue = toDecimal(serverCandy).plus(saved).toString();
    }

    setLocalRareCandy(nextValue);

    queueMicrotask(() => {
      emitCandyUpdate(nextValue);
    });
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
   * Flushes accumulated candy changes to the server.
   * Does NOT call updateUser — localRareCandy already reflects the correct
   * amount, and updating the user object would be redundant at best and
   * trigger stale-state overwrites at worst.
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
      await updateRareCandy(amountToSync);
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
  }, [unsyncedAmount, isAuthenticated, updateRareCandy]);

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

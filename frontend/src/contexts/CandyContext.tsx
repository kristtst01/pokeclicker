/**
 * Global Candy Context
 *
 * Provides candy state and passive income generation across the entire app.
 * This allows users to:
 * - See their candy count on all pages
 * - Earn passive income (autoclicker) globally
 * - Purchase Pokemon from any page using accumulated candy
 *
 * Architecture:
 * - Uses useCandySync for optimistic updates + batched backend syncing
 * - Uses useAutoclicker for passive income generation
 * - Exposes flushPendingCandy() for purchases/upgrades to ensure backend consistency
 *
 * Sync strategy:
 * - Local candy updates immediately (optimistic)
 * - Syncs to backend every 30 seconds or on unmount
 * - Before purchases/upgrades, flushes pending candy to ensure backend has accurate amount
 */
import {type ReactNode, useEffect, useRef} from 'react';
import {useAuth} from '@features/auth';
import {useCandySync} from '@features/clicker/hooks/useCandySync';
import {useAutoclicker} from '@features/clicker/hooks/useAutoclicker';
import {CandyContext} from './CandyContextBase';

interface CandyProviderProps {
  children: ReactNode;
  /** Disable autoclicker during onboarding */
  isOnboarding?: boolean;
}

export function CandyProvider({
  children,
  isOnboarding = false,
}: CandyProviderProps) {
  const {user, isAuthenticated, registerBeforeLogout} = useAuth();

  // Global candy sync system — localRareCandy is the source of truth during
  // the session.  Server state is only loaded on login (user._id change).
  const {
    localRareCandy,
    displayError,
    setDisplayError,
    addCandy,
    deductCandy,
    flushPendingCandy,
  } = useCandySync({
    user,
    isAuthenticated,
  });

  // Keep a ref to the latest flush so the before-logout callback always
  // calls the current closure without needing to re-register on every render.
  const flushRef = useRef(flushPendingCandy);
  useEffect(() => {
    flushRef.current = flushPendingCandy;
  }, [flushPendingCandy]);

  // Flush pending candy before logout clears the auth token, so the
  // updateRareCandy mutation still has a valid Authorization header.
  useEffect(() => {
    return registerBeforeLogout(() => flushRef.current());
  }, [registerBeforeLogout]);

  // Global autoclicker (runs on all pages)
  useAutoclicker({
    stats: user?.stats || {
      hp: 1,
      attack: 1,
      defense: 1,
      spAttack: 1,
      spDefense: 1,
      speed: 1,
      clickPower: 1,
      autoclicker: 1,
      luckyHitChance: 1,
      luckyHitMultiplier: 1,
      clickMultiplier: 1,
      pokedexBonus: 1,
    },
    isAuthenticated,
    onAutoClick: addCandy,
    ownedPokemonCount: user?.owned_pokemon_ids?.length || 0,
    isOnboarding,
  });

  return (
    <CandyContext.Provider
      value={{
        localRareCandy,
        addCandy,
        deductCandy,
        flushPendingCandy,
        displayError,
        setDisplayError,
      }}
    >
      {children}
    </CandyContext.Provider>
  );
}

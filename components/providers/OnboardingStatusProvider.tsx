"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useOnboardingStatus } from "@/hooks/useOnboardingStatus";

type OnboardingStatusContextValue = ReturnType<typeof useOnboardingStatus>;

const OnboardingStatusContext = createContext<OnboardingStatusContextValue | null>(null);

export function OnboardingStatusProvider({ children }: { children: ReactNode }) {
  const value = useOnboardingStatus();

  return (
    <OnboardingStatusContext.Provider value={value}>
      {children}
    </OnboardingStatusContext.Provider>
  );
}

export function useOnboardingStatusContext() {
  const context = useContext(OnboardingStatusContext);
  if (!context) {
    throw new Error("useOnboardingStatusContext must be used within an OnboardingStatusProvider");
  }
  return context;
}

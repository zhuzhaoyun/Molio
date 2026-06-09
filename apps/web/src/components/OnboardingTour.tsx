/**
 * Onboarding Tour — guided tutorial following Molio's core workflow:
 * 1. Configure runtime → 2. Import KB → 3. Build KB → 4. Chat creation → 5. Typeset → 6. Publish
 *
 * Uses @reactour/tour with custom Popover and cross-page navigation support.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { TourProvider, useTour, type StepType, type PopoverContentProps } from '@reactour/tour';
import { useI18n } from '../i18n';

// ─── Constants ───────────────────────────────────────────────

const TOUR_STORAGE_KEY = 'molio.tourCompleted';

function isTourCompleted(): boolean {
  try {
    return localStorage.getItem(TOUR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function markTourCompleted(): void {
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, 'true');
  } catch {
    // ignore storage errors
  }
}

// ─── Custom Popover Component ────────────────────────────────

function TourPopover({
  title,
  desc,
  currentStep,
  totalSteps,
  onNext,
  onPrev,
  onSkip,
  isFirst,
  isLast,
}: {
  title: string;
  desc: string;
  currentStep: number;
  totalSteps: number;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const { t } = useI18n();

  return (
    <div className="tour-popover">
      <div className="tour-popover__header">
        <span className="tour-popover__title">{title}</span>
        <span className="tour-popover__badge">
          {currentStep + 1}/{totalSteps}
        </span>
      </div>
      <p className="tour-popover__desc">{desc}</p>
      <div className="tour-popover__footer">
        <button className="tour-popover__btn tour-popover__btn--skip" onClick={onSkip}>
          {t('tour.skip')}
        </button>
        <div className="tour-popover__nav">
          {!isFirst && (
            <button className="tour-popover__btn tour-popover__btn--prev" onClick={onPrev}>
              {t('tour.prev')}
            </button>
          )}
          <button className="tour-popover__btn tour-popover__btn--next" onClick={onNext}>
            {isLast ? t('tour.done') : t('tour.next')}
          </button>
        </div>
      </div>
      {/* Dots indicator */}
      <div className="tour-popover__dots">
        {Array.from({ length: totalSteps }, (_, i) => (
          <span
            key={i}
            className={`tour-popover__dot ${i === currentStep ? 'is-active' : ''}`}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Steps Factory ───────────────────────────────────────────

function createSteps(t: (key: string) => string): StepType[] {
  return [
    // Step 1: Configure Runtime
    {
      selector: '.entry-nav-rail__btn[href="/runtimes"]',
      content: (props: PopoverContentProps) => (
        <TourPopover
          title={t('tour.step1.title')}
          desc={t('tour.step1.desc')}
          currentStep={props.currentStep}
          totalSteps={6}
          isFirst={props.currentStep === 0}
          isLast={props.currentStep === 5}
          onNext={() => props.setCurrentStep((s) => s + 1)}
          onPrev={() => props.setCurrentStep((s) => s - 1)}
          onSkip={() => {
            markTourCompleted();
            props.setIsOpen(false);
          }}
        />
      ),
      position: 'right',
    },
    // Step 2: Import Knowledge Base
    {
      selector: '.entry-nav-rail__btn[href="/knowledge"]',
      content: (props: PopoverContentProps) => (
        <TourPopover
          title={t('tour.step2.title')}
          desc={t('tour.step2.desc')}
          currentStep={props.currentStep}
          totalSteps={6}
          isFirst={props.currentStep === 0}
          isLast={props.currentStep === 5}
          onNext={() => props.setCurrentStep((s) => s + 1)}
          onPrev={() => props.setCurrentStep((s) => s - 1)}
          onSkip={() => {
            markTourCompleted();
            props.setIsOpen(false);
          }}
        />
      ),
      position: 'right',
    },
    // Step 3: Build Knowledge Base
    {
      selector: '.kb-file-panel',
      content: (props: PopoverContentProps) => (
        <TourPopover
          title={t('tour.step3.title')}
          desc={t('tour.step3.desc')}
          currentStep={props.currentStep}
          totalSteps={6}
          isFirst={props.currentStep === 0}
          isLast={props.currentStep === 5}
          onNext={() => props.setCurrentStep((s) => s + 1)}
          onPrev={() => props.setCurrentStep((s) => s - 1)}
          onSkip={() => {
            markTourCompleted();
            props.setIsOpen(false);
          }}
        />
      ),
      position: 'right',
    },
    // Step 4: Chat Creation
    {
      selector: '.entry-nav-rail__btn[href="/"]',
      content: (props: PopoverContentProps) => (
        <TourPopover
          title={t('tour.step4.title')}
          desc={t('tour.step4.desc')}
          currentStep={props.currentStep}
          totalSteps={6}
          isFirst={props.currentStep === 0}
          isLast={props.currentStep === 5}
          onNext={() => props.setCurrentStep((s) => s + 1)}
          onPrev={() => props.setCurrentStep((s) => s - 1)}
          onSkip={() => {
            markTourCompleted();
            props.setIsOpen(false);
          }}
        />
      ),
      position: 'right',
    },
    // Step 5: Typeset & Style
    {
      selector: '.kb-main-header',
      content: (props: PopoverContentProps) => (
        <TourPopover
          title={t('tour.step5.title')}
          desc={t('tour.step5.desc')}
          currentStep={props.currentStep}
          totalSteps={6}
          isFirst={props.currentStep === 0}
          isLast={props.currentStep === 5}
          onNext={() => props.setCurrentStep((s) => s + 1)}
          onPrev={() => props.setCurrentStep((s) => s - 1)}
          onSkip={() => {
            markTourCompleted();
            props.setIsOpen(false);
          }}
        />
      ),
      position: 'bottom',
    },
    // Step 6: Publish
    {
      selector: '.kb-main-header',
      content: (props: PopoverContentProps) => (
        <TourPopover
          title={t('tour.step6.title')}
          desc={t('tour.step6.desc')}
          currentStep={props.currentStep}
          totalSteps={6}
          isFirst={props.currentStep === 0}
          isLast={props.currentStep === 5}
          onNext={() => {
            markTourCompleted();
            props.setIsOpen(false);
          }}
          onPrev={() => props.setCurrentStep((s) => s - 1)}
          onSkip={() => {
            markTourCompleted();
            props.setIsOpen(false);
          }}
        />
      ),
      position: 'bottom',
    },
  ];
}

// ─── Cross-Page Navigation Handler ──────────────────────────

// Maps step index to the route where its target element lives
const STEP_ROUTES: Record<number, string> = {
  0: '/',           // Runtimes button is on NavRail (visible on all pages, but start at home)
  1: '/knowledge',  // Knowledge Base button → navigate to KB page
  2: '/knowledge',  // kb-file-panel is on KB page
  3: '/',           // Home button → navigate to home
  4: '/knowledge',  // kb-main-header is on KB page
  5: '/knowledge',  // kb-main-header is on KB page
};

function useCrossPageNavigation(
  currentStep: number,
  isOpen: boolean,
  setCurrentStep: React.Dispatch<React.SetStateAction<number>>,
) {
  const navigate = useNavigate();
  const location = useLocation();
  const prevStepRef = useRef(currentStep);

  useEffect(() => {
    if (!isOpen) return;

    const prevStep = prevStepRef.current;
    prevStepRef.current = currentStep;

    // Only navigate when step actually changed
    if (prevStep === currentStep) return;

    const targetRoute = STEP_ROUTES[currentStep];
    if (targetRoute && location.pathname !== targetRoute) {
      navigate(targetRoute);
    }
  }, [currentStep, isOpen, navigate, location.pathname]);
}

// ─── Inner Controller (must be inside TourProvider + Router) ─

function TourController() {
  const { isOpen, setIsOpen, currentStep, setCurrentStep } = useTour();
  useCrossPageNavigation(currentStep, isOpen, setCurrentStep);

  // Auto-start on first visit
  useEffect(() => {
    if (!isTourCompleted()) {
      // Small delay to let the page render target elements
      const timer = setTimeout(() => {
        setIsOpen(true);
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [setIsOpen]);

  return null;
}

// ─── Provider Wrapper ────────────────────────────────────────

export function OnboardingTourProvider({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const steps = createSteps(t);

  return (
    <TourProvider
      steps={steps}
      showNavigation={false}
      showCloseButton={false}
      showBadge={false}
      padding={{ mask: 8, popover: [12, 16] }}
      styles={{
        popover: () => ({
          background: 'transparent',
          boxShadow: 'none',
          padding: 0,
          borderRadius: 0,
        }),
      }}
      disableFocusLock
      afterOpen={(target) => {
        // Ensure target element is visible when tour opens
      }}
      beforeClose={() => {
        markTourCompleted();
      }}
    >
      {children}
      <TourController />
    </TourProvider>
  );
}

// ─── Hook for external trigger (e.g., NavRail button) ───────

export function useStartTour() {
  const { setIsOpen, setCurrentStep } = useTour();

  return useCallback(() => {
    setCurrentStep(0);
    setIsOpen(true);
  }, [setIsOpen, setCurrentStep]);
}

import posthog from 'posthog-js';

// PostHog Project API key & Host Configuration (loaded securely from .env)
export const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY || '';
export const POSTHOG_HOST =
  import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';

let isInitialized = false;

/**
 * Initialize PostHog for product analytics and session replay
 */
export function initPostHog() {
  if (typeof window === 'undefined' || isInitialized || !POSTHOG_KEY) return;

  try {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      autocapture: true,
      capture_pageview: true,
      capture_pageleave: true,
      disable_session_recording: false,
      session_recording: {
        recordCrossOriginIframes: true,
        maskAllInputs: false,
      },
      loaded: (ph) => {
        if (import.meta.env.DEV) {
          console.info('🦔 PostHog initialized successfully for session replay & analytics');
        }
      },
    });
    isInitialized = true;
  } catch (error) {
    console.error('Failed to initialize PostHog:', error);
  }
}

/**
 * Track custom product analytics events
 * @param {string} eventName - Name of the event
 * @param {Record<string, any>} [properties={}] - Custom event metadata
 */
export function trackEvent(eventName, properties = {}) {
  try {
    if (isInitialized || posthog.__loaded) {
      posthog.capture(eventName, {
        timestamp: new Date().toISOString(),
        ...properties,
      });
    }
  } catch (err) {
    console.warn(`[PostHog] Failed to capture event: ${eventName}`, err);
  }
}

/**
 * Identify user with PostHog
 * @param {string} distinctId
 * @param {Record<string, any>} [properties={}]
 */
export function identifyUser(distinctId, properties = {}) {
  try {
    posthog.identify(distinctId, properties);
  } catch (err) {
    console.warn('[PostHog] Failed to identify user', err);
  }
}

export { posthog };

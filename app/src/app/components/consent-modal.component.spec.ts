/**
 * @file consent-modal.component.spec.ts
 * @description Unit tests for consent modal end-of-document detection.
 */
import { describe, expect, it } from 'vitest';
import { hasReachedScrollEnd } from './consent-modal.component';

describe('consent modal scroll gate', () => {
  it('stays locked before long content reaches the end', () => {
    expect(hasReachedScrollEnd({ scrollTop: 200, clientHeight: 600, scrollHeight: 1200 })).toBe(false);
  });

  it('unlocks when long content reaches the end', () => {
    expect(hasReachedScrollEnd({ scrollTop: 600, clientHeight: 600, scrollHeight: 1200 })).toBe(true);
  });

  it('unlocks short content and responds to a resized viewport', () => {
    expect(hasReachedScrollEnd({ scrollTop: 0, clientHeight: 600, scrollHeight: 500 })).toBe(true);
    expect(hasReachedScrollEnd({ scrollTop: 200, clientHeight: 700, scrollHeight: 1000 })).toBe(false);
    expect(hasReachedScrollEnd({ scrollTop: 200, clientHeight: 800, scrollHeight: 1000 })).toBe(true);
  });
});

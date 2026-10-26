/**
 * @file app.component.spec.ts
 * @description Side-menu focus transfer and navigation-order regression tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeMenuBeforeNavigation } from './app.component';

describe('side-menu navigation accessibility', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('releases menu focus, closes once, navigates, then focuses visible content', async () => {
    const menu = document.createElement('div');
    const trigger = document.createElement('button');
    const destination = document.createElement('main');
    destination.tabIndex = -1;
    menu.appendChild(trigger);
    document.body.append(menu, destination);
    trigger.focus();
    const order: string[] = [];
    const close = vi.fn(async () => {
      expect(document.activeElement).not.toBe(trigger);
      order.push('close');
    });
    const navigate = vi.fn(async () => order.push('navigate'));

    await closeMenuBeforeNavigation(
      { currentTarget: trigger } as unknown as Event,
      close,
      navigate,
      () => {
        order.push('focus');
        destination.focus();
      },
    );

    expect(close).toHaveBeenCalledOnce();
    expect(order).toEqual(['close', 'navigate', 'focus']);
    expect(document.activeElement).toBe(destination);
  });

  it('uses the same single lifecycle for native button activation', async () => {
    const trigger = document.createElement('button');
    const destination = document.createElement('main');
    destination.tabIndex = -1;
    document.body.append(trigger, destination);
    const close = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => undefined);
    let completion = Promise.resolve();
    trigger.addEventListener('click', (event) => {
      completion = closeMenuBeforeNavigation(event, close, navigate, () => destination.focus());
    });

    trigger.focus();
    trigger.click();
    await completion;

    expect(close).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(destination);
  });
});

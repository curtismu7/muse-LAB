// The consent dialog and the pi.flow Sign in dialog are shared FloatingDialogs: the title bar is the drag handle; only the frame changed.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// The DaVinci SDK is stubbed: this test is about the frame, not PingOne. start() never settles, so the dialog stays on "Opening PingOne…".
vi.mock('@forgerock/davinci-client', () => ({ davinci: vi.fn(async () => ({ start: () => new Promise(() => {}) })) }));
vi.mock('@forgerock/protect', () => ({ protect: vi.fn() }));

import { ConsentModal } from '../App.jsx';
import SignInModal from '../SignInModal.jsx';

describe('consent dialog', () => {
  it('is a modal FloatingDialog with a title bar handle; the two buttons give the same answers; Escape does not answer (as before)', () => {
    const resolve = vi.fn();
    render(<ConsentModal ask={{ prompt: 'Allow Personal Agent to read your calendar?', resolve }} />);
    const dialog = screen.getByRole('dialog', { name: 'Personal Agent is a bot' });
    expect(dialog).toHaveClass('fd-panel');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByTestId('fd-titlebar')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Yes, I consent' }));
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(resolve).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'No, do not allow' }));
    expect(resolve).toHaveBeenLastCalledWith(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, I consent' }));
    expect(resolve).toHaveBeenLastCalledWith(true);
  });
});

describe('Sign in dialog (pi.flow)', () => {
  const config = { clientId: 'c', redirectUri: 'http://127.0.0.1/cb', scope: 'openid', wellknown: 'https://auth.example/env/as/.well-known/openid-configuration', query: {} };

  it('is a non-modal FloatingDialog with a title bar handle and no pop-out; Escape cancels once', async () => {
    const onClose = vi.fn();
    render(<SignInModal config={config} api={vi.fn()} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Sign in' });
    expect(dialog).toHaveAttribute('data-testid', 'signin-modal');
    expect(dialog).toHaveClass('fd-panel');
    expect(dialog).not.toHaveAttribute('aria-modal');
    expect(within(dialog).getByTestId('fd-titlebar')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Pop out to a new window' })).toBeNull();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Opening PingOne');
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })));
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ cancelled: true });
  });

  it('Escape anywhere on the page still cancels, and Cancel answers the same', () => {
    const onClose = vi.fn();
    render(<SignInModal config={config} api={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith({ cancelled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenLastCalledWith({ cancelled: true });
  });
});

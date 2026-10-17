import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';
import { saveAccessToken } from '../core/access-token-storage';

/** Asks for the server's access token and keeps it for this tab. */
@Component({
  selector: 'app-token-prompt',
  template: `
    <main class="token-prompt-page">
      <form class="panel-dark token-prompt" (submit)="submitToken($event)">
        <h1 class="token-prompt-heading">Enter the access token</h1>
        <p>This server needs the token it was started with. It is kept for this tab only.</p>
        <label class="stack">
          <span>Access token</span>
          <input
            class="token-field"
            type="password"
            autocomplete="off"
            required
            [value]="accessToken()"
            (input)="updateAccessToken($event)"
          />
        </label>
        <button class="button button-gradient" type="submit">Continue</button>
      </form>
    </main>
  `,
  styles: `
    .token-prompt-page {
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 1rem;
    }
    .token-prompt {
      width: min(100%, 440px);
      padding: 2rem;
      display: grid;
      gap: 1rem;
      border-radius: 2rem;
    }
    .token-prompt-heading {
      font-size: 1.8rem;
    }
    .token-field {
      min-height: 44px;
      padding: 0 1rem;
      border-radius: 0.9rem;
      border: 1px solid rgba(255, 255, 255, 0.25);
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TokenPromptComponent {
  /** The token was saved; connect again. */
  readonly tokenSubmit = output();
  protected readonly accessToken = signal('');

  protected updateAccessToken(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.accessToken.set(event.target.value);
  }

  protected submitToken(event: Event): void {
    event.preventDefault();
    saveAccessToken(this.accessToken().trim());
    this.tokenSubmit.emit();
  }
}

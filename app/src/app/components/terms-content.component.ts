/**
 * @file terms-content.component.ts
 * @description Shared Terms of Use body for the policy page and consent modal.
 */
import { Component } from '@angular/core';

@Component({
  selector: 'app-terms-content',
  template: `
    <p class="lead">These simple terms explain how to use the Cookie Fluffs app fairly and responsibly.</p>

    <div class="value-grid">
      <section class="cf-card value">
        <h3>Using the app</h3>
        <p>Use Cookie Fluffs to browse cookies, manage your cart and place orders. Please use the app only for its intended purpose.</p>
      </section>

      <section class="cf-card value">
        <h3>Your account</h3>
        <p>Keep your password private and give accurate account and delivery details. You are responsible for activity on your account.</p>
      </section>

      <section class="cf-card value">
        <h3>Orders and prices</h3>
        <p>Prices are shown in Philippine pesos and may change. Cookies and other items may sell out or become unavailable.</p>
      </section>

      <section class="cf-card value">
        <h3>Fair use</h3>
        <p>Do not misuse the app, interfere with how it works or try to access another person's account.</p>
      </section>

      <section class="cf-card value">
        <h3>Changes to these terms</h3>
        <p>We may update this draft as the class project grows. The latest version will appear on this page.</p>
      </section>
    </div>
  `,
  styleUrls: ['../pages/info-page.scss'],
  styles: ':host { display: contents; }',
})
export class TermsContentComponent {}

/**
 * @file privacy-content.component.ts
 * @description Shared Privacy Policy body for the policy page and consent modal.
 */
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonButton } from '@ionic/angular';

@Component({
  selector: 'app-privacy-content',
  imports: [RouterLink, IonButton],
  template: `
    <p class="lead">This page explains what information Cookie Fluffs uses and why it is needed.</p>

    <div class="value-grid">
      <section class="cf-card value">
        <h3>What we collect</h3>
        <p>We collect your name, email, mobile number, optional profile photo, cart, orders, saved addresses, favorites, accessibility preferences, and messages you send us. You may also add an optional gender and date of birth.</p>
      </section>

      <section class="cf-card value">
        <h3>Optional profile details</h3>
        <p>Gender and date of birth are optional. They are never required to sign up, sign in with Google, or place an order, and we use them only to personalize your account profile. We do not use them for age limits, birthday promotions, pricing, or marketing. You can add, change, or clear them anytime in Edit Profile, and they are not shared with third parties.</p>
      </section>

      <section class="cf-card value">
        <h3>How we use it</h3>
        <p>We use this information to run your account, remember your choices, handle orders and delivery, and receive your support messages.</p>
      </section>

      <section class="cf-card value">
        <h3>How we protect it</h3>
        <p>Your password is stored in a scrambled form and cannot be read. Other app data is kept in a cloud database.</p>
      </section>

      <section class="cf-card value">
        <h3>Your choices</h3>
        <p>You can update your details in the app. To ask us to delete your account for now, use Contact Us.</p>
      </section>

      <section class="cf-card value">
        <h3>Contact</h3>
        <p>Questions about your information? Send us a message through the Contact Us page.</p>
        <ion-button fill="outline" routerLink="/contact" routerDirection="forward">Contact Us</ion-button>
      </section>
    </div>
  `,
  styleUrls: ['../pages/info-page.scss'],
  styles: ':host { display: contents; }',
})
export class PrivacyContentComponent {}

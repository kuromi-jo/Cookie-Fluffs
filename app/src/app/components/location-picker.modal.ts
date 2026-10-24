/**
 * @file location-picker.modal.ts
 * @description Searchable, keyboard-accessible picker for NCR cities and barangays.
 */
import { Component, EventEmitter, Input, Output, computed, signal } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonModal,
  IonSearchbar,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { GeographicOption } from '../core/geography.service';

export const LOCATION_SHEET_BREAKPOINTS = [0, 1];
export const LOCATION_SHEET_INITIAL_BREAKPOINT = 1;

@Component({
  selector: 'app-location-picker',
  templateUrl: 'location-picker.modal.html',
  styleUrls: ['location-picker.modal.scss'],
  imports: [IonModal, IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent, IonSearchbar, IonIcon],
})
export class LocationPickerModalComponent {
  readonly breakpoints = LOCATION_SHEET_BREAKPOINTS;
  readonly initialBreakpoint = LOCATION_SHEET_INITIAL_BREAKPOINT;
  @Input() isOpen = false;
  @Input() title = 'Choose a location';
  @Input() searchPlaceholder = 'Search locations';
  @Input() selectedCode = '';
  @Input() set options(value: GeographicOption[]) {
    this.available.set(value);
  }
  @Output() selected = new EventEmitter<GeographicOption>();
  @Output() closed = new EventEmitter<void>();

  readonly query = signal('');
  private available = signal<GeographicOption[]>([]);
  readonly filtered = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return query
      ? this.available().filter((option) => option.name.toLocaleLowerCase().includes(query))
      : this.available();
  });

  choose(option: GeographicOption): void {
    this.selected.emit(option);
    this.query.set('');
  }

  dismiss(): void {
    this.query.set('');
    this.closed.emit();
  }
}

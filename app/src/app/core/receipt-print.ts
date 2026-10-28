/**
 * @file receipt-print.ts
 * @description Opens the system print screen for the receipt page. On the Android app this uses the
 * native ReceiptPrint plugin (Android print dialog with "Save as PDF"), because window.print() does
 * nothing inside a WebView; in browsers it uses window.print(). The page title is set to the receipt
 * name while printing so a saved PDF gets a clear file name.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

interface ReceiptPrintPlugin {
  print(options: { name: string }): Promise<{ opened: boolean }>;
}

const NativeReceiptPrint = registerPlugin<ReceiptPrintPlugin>('ReceiptPrint');

export async function printReceipt(name: string): Promise<void> {
  const previousTitle = document.title;
  document.title = name;
  try {
    if (Capacitor.isNativePlatform()) await NativeReceiptPrint.print({ name });
    else window.print();
  } finally {
    // The native dialog renders asynchronously; restore the title once it has taken its snapshot.
    setTimeout(() => (document.title = previousTitle), 1500);
  }
}

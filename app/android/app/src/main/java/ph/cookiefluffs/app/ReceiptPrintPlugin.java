/*
 * @file ReceiptPrintPlugin.java
 * @description Prints the current app screen (the receipt page) through Android's system print
 * dialog, which also offers "Save as PDF". window.print() does nothing inside an Android WebView,
 * so the web app calls this plugin on the APK and falls back to window.print() in browsers.
 */
package ph.cookiefluffs.app;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ReceiptPrint")
public class ReceiptPrintPlugin extends Plugin {

    @PluginMethod
    public void print(PluginCall call) {
        String requested = call.getString("name", "Cookie Fluffs receipt");
        // Keep the job (and the suggested PDF file name) short and free of path characters.
        String jobName = requested.replaceAll("[^A-Za-z0-9 #._-]", "").trim();
        if (jobName.isEmpty()) jobName = "Cookie Fluffs receipt";
        final String name = jobName.length() > 60 ? jobName.substring(0, 60) : jobName;

        getActivity().runOnUiThread(() -> {
            try {
                PrintManager printManager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                WebView webView = getBridge().getWebView();
                if (printManager == null || webView == null) {
                    call.reject("Printing is not available on this device.");
                    return;
                }
                PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(name);
                PrintAttributes attributes = new PrintAttributes.Builder()
                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                    .build();
                printManager.print(name, adapter, attributes);
                JSObject result = new JSObject();
                result.put("opened", true);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Printing is not available on this device.");
            }
        });
    }
}

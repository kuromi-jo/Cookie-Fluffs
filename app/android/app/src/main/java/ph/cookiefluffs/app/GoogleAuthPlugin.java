/**
 * @file GoogleAuthPlugin.java
 * @description Capacitor bridge to Android Credential Manager Sign in with Google.
 */
package ph.cookiefluffs.app;

import android.os.CancellationSignal;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

@CapacitorPlugin(name = "GoogleAuth")
public class GoogleAuthPlugin extends Plugin {
    @PluginMethod
    public void signIn(PluginCall call) {
        String serverClientId = call.getString("serverClientId");
        String nonce = call.getString("nonce");
        if (serverClientId == null || serverClientId.isBlank() || nonce == null || nonce.isBlank()) {
            call.reject("Google sign-in configuration is incomplete.");
            return;
        }

        GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(serverClientId)
            .setNonce(nonce)
            .build();
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(option)
            .build();
        CredentialManager manager = CredentialManager.create(getActivity());
        manager.getCredentialAsync(
            getActivity(),
            request,
            new CancellationSignal(),
            getActivity().getMainExecutor(),
            new androidx.credentials.CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    Credential credential = response.getCredential();
                    if (!(credential instanceof CustomCredential)
                        || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                        call.reject("Google did not return a supported credential.");
                        return;
                    }
                    try {
                        GoogleIdTokenCredential googleCredential = GoogleIdTokenCredential.createFrom(
                            ((CustomCredential) credential).getData()
                        );
                        JSObject result = new JSObject();
                        result.put("idToken", googleCredential.getIdToken());
                        call.resolve(result);
                    } catch (Exception ignored) {
                        call.reject("Google returned an invalid credential.");
                    }
                }

                @Override
                public void onError(GetCredentialException error) {
                    call.reject("Google sign-in was cancelled or unavailable.");
                }
            }
        );
    }
}

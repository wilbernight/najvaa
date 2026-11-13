<?php

namespace App\Http\Controllers\Panel;

use App\Http\Controllers\Controller;
use App\Models\AdminLog;
use App\Support\Jalali;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Hash;
use Laravel\Fortify\Contracts\TwoFactorAuthenticationProvider;
use Laravel\Nova\Nova;

/** Re-confirms the admin (password + authenticator code) before sensitive actions. */
class StepUpController extends Controller
{
    public function show(Request $request)
    {
        return view('panel.stepup', [
            'needsCode' => filled($request->user()->two_factor_confirmed_at),
            'back' => $request->session()->get('panel.stepup_back', route('panel.dashboard')),
        ]);
    }

    public function store(Request $request, TwoFactorAuthenticationProvider $totp)
    {
        $user = $request->user();
        $data = $request->validate([
            'password' => ['required', 'string', 'max:200'],
            'code' => [filled($user->two_factor_confirmed_at) ? 'required' : 'nullable', 'string', 'max:12'],
        ]);

        $ok = Hash::check($data['password'], $user->password);
        if ($ok && filled($user->two_factor_confirmed_at)) {
            $code = preg_replace('/\D/', '', Jalali::latin((string) $data['code']));
            // A code works once: replaying one seen in the last 90 s fails.
            $replay = 'stepup-code:'.$user->id.':'.$code;
            $ok = ! Cache::has($replay) && $totp->verify(decrypt($user->two_factor_secret), $code);
            if ($ok) {
                Cache::put($replay, 1, 90);
            }
        }

        if (! $ok) {
            AdminLog::record('stepup.failed');
            $fails = Cache::increment('stepup-fails:'.$user->id);
            Cache::put('stepup-fails:'.$user->id, $fails, 900);
            if ($fails >= 5) {
                // Five wrong confirmations in a row: the session ends.
                Cache::forget('stepup-fails:'.$user->id);
                AdminLog::record('stepup.locked');
                Auth::guard('web')->logout();
                $request->session()->invalidate();
                $request->session()->regenerateToken();

                return redirect(url(Nova::path().'/login'));
            }

            return back()->withErrors(['password' => 'رمز یا کد تأیید نادرست است.']);
        }

        Cache::forget('stepup-fails:'.$user->id);
        $request->session()->put('panel.stepup_at', time());
        $request->session()->regenerate();
        AdminLog::record('stepup.ok');

        $back = (string) $request->session()->pull('panel.stepup_back', route('panel.dashboard'));
        // Only ever back into this panel.
        if (! str_starts_with($back, url('/'))) {
            $back = route('panel.dashboard');
        }

        return redirect()->to($back)->with('panel.flash', 'هویت شما تأیید شد؛ تا چند دقیقه می‌توانید کارهای حساس را انجام دهید.');
    }

    public function logout(Request $request)
    {
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return redirect(url(Nova::path().'/login'));
    }
}

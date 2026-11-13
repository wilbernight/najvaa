<?php

namespace App\Http\Middleware;

use App\Models\AdminLog;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Laravel\Nova\Nova;
use Symfony\Component\HttpFoundation\Response;

/**
 * Session hardening for the panel:
 *  - idle timeout (NAJVA_IDLE_MINUTES, default 15): no activity → signed out;
 *  - the session is bound to the browser that signed in (user agent) and,
 *    unless NAJVA_BIND_IP=false, to its address: a cookie replayed from
 *    somewhere else is signed out and the attempt goes in the audit log.
 * Background refreshes (X-Panel-Poll) do not count as activity.
 */
class PanelSession
{
    public function handle(Request $request, Closure $next): Response
    {
        $s = $request->session();
        $now = time();
        $idle = (int) config('najva.idle_minutes', 15) * 60;
        $fp = hash('sha256', (string) $request->userAgent().'|'.(config('najva.bind_ip', true) ? $request->ip() : ''));

        $bound = $s->get('panel.fp');
        $last = (int) $s->get('panel.seen', $now);

        if ($bound && ! hash_equals($bound, $fp)) {
            return $this->out($request, 'session.mismatch', 'نشست شما از دستگاه یا نشانی دیگری استفاده شد و بسته شد. دوباره وارد شوید.');
        }
        if ($now - $last > $idle) {
            return $this->out($request, 'session.idle', 'به دلیل عدم فعالیت از پنل خارج شدید.');
        }

        if (! $bound) {
            $s->put('panel.fp', $fp);
            $s->regenerate();   // fresh id once the panel session starts
        }
        if (! $request->headers->has('X-Panel-Poll')) {
            $s->put('panel.seen', $now);
        }

        $response = $next($request);
        $response->headers->set('X-Panel-Idle', (string) max(0, $idle - ($now - (int) $s->get('panel.seen', $now))));

        return $response;
    }

    private function out(Request $request, string $action, string $message): Response
    {
        AdminLog::record($action, $request->path(), ['ip' => $request->ip()]);
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();
        $request->session()->flash('panel.flash', $message);
        // After signing in again, come back to the panel (not Nova's dashboard).
        $request->session()->put('url.intended', $request->isMethod('GET') && ! $request->headers->has('X-Panel-Poll') ? $request->fullUrl() : url('/'));

        return $request->expectsJson() || $request->headers->has('X-Panel-Poll')
            ? response()->json(['message' => $message], 401)
            : redirect(url(Nova::path().'/login'));
    }
}

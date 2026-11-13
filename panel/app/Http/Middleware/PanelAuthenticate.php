<?php

namespace App\Http\Middleware;

use App\Models\AdminLog;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Laravel\Nova\Nova;
use Symfony\Component\HttpFoundation\Response;

/**
 * The panel reuses Nova's sign-in (password, TOTP, passkeys). Anyone not
 * signed in is sent there and comes back afterwards; a signed-in account that
 * is not on the admin list (or not the person Cloudflare Access verified) is
 * signed out on the spot.
 */
class PanelAuthenticate
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();
        if (! $user) {
            return $request->expectsJson()
                ? response()->json(['message' => 'unauthenticated'], 401)
                : redirect()->guest(url(Nova::path().'/login'));
        }

        $accessOk = ! config('najva.access.enabled') || $request->attributes->get('access_email') === strtolower($user->email);
        if (! $user->isPanelAdmin() || ! $accessOk || ! $user->can('view')) {
            AdminLog::record('access.denied', $request->path(), ['reason' => ! $accessOk ? 'access-identity' : 'not-admin'], $user);
            Auth::guard('web')->logout();
            $request->session()->invalidate();
            $request->session()->regenerateToken();
            abort(403);
        }

        return $next($request);
    }
}

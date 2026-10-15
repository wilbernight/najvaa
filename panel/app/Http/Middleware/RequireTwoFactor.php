<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Laravel\Nova\Nova;
use Symfony\Component\HttpFoundation\Response;

/**
 * An admin without two-factor authentication or a passkey can only reach
 * the account-security page (to set one up) and log out. Everything else in
 * the panel stays closed until then.
 */
class RequireTwoFactor
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();
        if (! $user || app()->environment('local') || $this->secured($user) || $this->allowed($request)) {
            return $next($request);
        }

        if ($request->expectsJson() || $request->header('X-Inertia')) {
            abort(403, 'Two-factor authentication or a passkey is required.');
        }

        return redirect(Nova::url('/user-security'));
    }

    private function secured($user): bool
    {
        return filled($user->two_factor_confirmed_at)
            || (method_exists($user, 'passkeys') && $user->passkeys()->exists());
    }

    private function allowed(Request $request): bool
    {
        $base = trim(Nova::path(), '/');
        $p = trim($request->path(), '/');
        $rel = ($base === '' || ! str_starts_with($p, $base)) ? $p : ltrim(substr($p, strlen($base)), '/');

        foreach (['user-security', 'login', 'logout'] as $prefix) {   // 2FA + passkey setup live under user-security
            if ($rel === $prefix || str_starts_with($rel, $prefix.'/')) {
                return true;
            }
        }

        return str_starts_with($p, 'nova-api/scripts/')
            || str_starts_with($p, 'nova-api/styles/')
            || str_starts_with($p, 'nova-api/nova-notifications');
    }
}

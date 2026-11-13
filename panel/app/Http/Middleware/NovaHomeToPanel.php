<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Laravel\Nova\Nova;
use Symfony\Component\HttpFoundation\Response;

/**
 * Nova's own home (its old dashboard) is replaced by the panel at the site
 * root: signing in through Nova, its logo and its home link all land there.
 * Nova's account-security and resource pages stay as they are.
 */
class NovaHomeToPanel
{
    public function handle(Request $request, Closure $next): Response
    {
        if ($request->isMethod('GET')) {
            $base = trim(Nova::path(), '/');
            $p = trim($request->path(), '/');
            if (in_array($p, [$base, $base.'/dashboards/main', $base.'/dashboards'], true)) {
                return $request->header('X-Inertia')
                    ? response('', 409)->header('X-Inertia-Location', url('/'))   // Inertia: full page visit
                    : redirect(url('/'));
            }
        }

        return $next($request);
    }
}

<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Sensitive actions (deleting a room, holds, watches, exports, blocks, roles,
 * settings) need a fresh confirmation of the password and the authenticator
 * code, valid for NAJVA_STEPUP_MINUTES (default 5). Without it the admin is
 * sent to the confirmation page and then back to where they were.
 */
class RequireStepUp
{
    public function handle(Request $request, Closure $next): Response
    {
        $at = (int) $request->session()->get('panel.stepup_at', 0);
        if (time() - $at <= (int) config('najva.stepup_minutes', 5) * 60) {
            return $next($request);
        }

        $back = $request->isMethod('GET') ? $request->fullUrl() : url()->previous();
        $request->session()->put('panel.stepup_back', $back);

        return redirect()->route('panel.stepup')
            ->with('panel.flash', $request->isMethod('GET') ? null : 'برای این کار، هویت خود را دوباره تأیید کنید و سپس دوباره اقدام کنید.');
    }
}

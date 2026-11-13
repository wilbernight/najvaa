<?php

use App\Http\Middleware\RequireTwoFactor;
use App\Http\Middleware\SecurityHeaders;
use App\Http\Middleware\VerifyCloudflareAccess;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // nginx only accepts connections from Cloudflare and passes the real
        // visitor address on; the app itself only ever talks to nginx.
        $middleware->trustProxies(at: '127.0.0.1', headers: Request::HEADER_X_FORWARDED_FOR | Request::HEADER_X_FORWARDED_PROTO);

        $middleware->prepend(SecurityHeaders::class);
        $middleware->web(prepend: [VerifyCloudflareAccess::class], append: [\App\Http\Middleware\NovaHomeToPanel::class]);
        $middleware->alias([
            'najva.2fa' => RequireTwoFactor::class,
            'panel.auth' => \App\Http\Middleware\PanelAuthenticate::class,
            'panel.session' => \App\Http\Middleware\PanelSession::class,
            'panel.csp' => \App\Http\Middleware\PanelCsp::class,
            'panel.stepup' => \App\Http\Middleware\RequireStepUp::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->dontFlash(['password', 'password_confirmation', 'current_password', 'code', 'recovery_code']);
    })->create();

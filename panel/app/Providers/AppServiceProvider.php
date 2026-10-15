<?php

namespace App\Providers;

use App\Models\AdminLog;
use App\Models\User;
use Illuminate\Auth\Events\Failed;
use Illuminate\Auth\Events\Lockout;
use Illuminate\Auth\Events\Login;
use Illuminate\Auth\Events\Logout;
use Illuminate\Auth\Events\PasswordReset;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\ServiceProvider;
use Illuminate\Validation\Rules\Password;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        //
    }

    public function boot(): void
    {
        if ($this->app->isProduction()) {
            URL::forceScheme('https');
        }

        Password::defaults(fn () => Password::min(14)->mixedCase()->numbers()->symbols()
            ->when($this->app->isProduction(), fn ($rule) => $rule->uncompromised()));

        // Admin audit trail. Only panel accounts are logged; never chat users.
        Event::listen(Login::class, fn (Login $e) => $e->user instanceof User
            ? AdminLog::record('login', null, [], $e->user) : null);
        Event::listen(Logout::class, fn (Logout $e) => $e->user instanceof User
            ? AdminLog::record('logout', null, [], $e->user) : null);
        Event::listen(Failed::class, fn (Failed $e) => AdminLog::record(
            'login.failed', null, [], null, mb_substr((string) ($e->credentials['email'] ?? ''), 0, 191) ?: null));
        Event::listen(Lockout::class, fn (Lockout $e) => AdminLog::record(
            'lockout', null, [], null, mb_substr((string) $e->request->input('email', ''), 0, 191) ?: null));
        Event::listen(PasswordReset::class, fn (PasswordReset $e) => AdminLog::record('password.changed', null, [], $e->user));
    }
}

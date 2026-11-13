<?php

namespace App\Providers;

use App\Models\AdminLog;
use App\Models\User;
use App\Support\Perm;
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

        Perm::register();

        // Panel view helpers: @icon('lock'), and $J (Jalali dates, Persian digits).
        \Illuminate\Support\Facades\Blade::directive('icon', fn (string $args) => "<?php echo \\App\\Support\\Icons::svg({$args}); ?>");
        \Illuminate\Support\Facades\View::share('J', new \App\Support\Jalali);
        \Illuminate\Support\Facades\View::composer('panel.layout', function ($view) {
            $f = public_path('panel/panel.css');
            $view->with('assetV', is_file($f) ? substr(md5((string) filemtime($f).filemtime(public_path('panel/panel.js'))), 0, 8) : '1');
            $view->with('navBadges', [
                'online' => \App\Models\Room::query()->where('online', '>', 0)->count(),
                'cases' => \App\Models\LegalCase::query()->whereIn('status', \App\Models\LegalCase::OPEN)->count(),
                'reports' => \App\Models\AbuseReport::query()->where('status', 'new')->count(),
                'severe' => \App\Models\AbuseReport::query()->where('status', 'new')->whereIn('reason', \App\Models\AbuseReport::SEVERE)->exists(),
            ]);
        });

        Password::defaults(fn () => Password::min(14)->mixedCase()->numbers()->symbols()
            ->when($this->app->isProduction(), fn ($rule) => $rule->uncompromised()));

        // Admin audit trail. Only panel accounts are logged; never chat users.
        Event::listen(Login::class, function (Login $e) {
            if (! $e->user instanceof User) {
                return;
            }
            AdminLog::record('login', null, [], $e->user);
            $e->user->forceFill(['last_login_at' => now(), 'last_login_ip' => request()->ip()])->saveQuietly();
            // A fresh sign-in starts a fresh panel session (idle clock, binding, step-up).
            session()->forget(['panel.seen', 'panel.fp', 'panel.stepup_at']);
        });
        Event::listen(Logout::class, fn (Logout $e) => $e->user instanceof User
            ? AdminLog::record('logout', null, [], $e->user) : null);
        Event::listen(Failed::class, fn (Failed $e) => AdminLog::record(
            'login.failed', null, [], null, mb_substr((string) ($e->credentials['email'] ?? ''), 0, 191) ?: null));
        Event::listen(Lockout::class, fn (Lockout $e) => AdminLog::record(
            'lockout', null, [], null, mb_substr((string) $e->request->input('email', ''), 0, 191) ?: null));
        Event::listen(PasswordReset::class, fn (PasswordReset $e) => AdminLog::record('password.changed', null, [], $e->user));
    }
}

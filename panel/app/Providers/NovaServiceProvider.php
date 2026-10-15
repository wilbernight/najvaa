<?php

namespace App\Providers;

use App\Models\AdminLog as AdminLogModel;
use App\Models\Room as RoomModel;
use App\Models\ServiceCheck as ServiceCheckModel;
use App\Models\User;
use App\Nova\AdminLog;
use App\Nova\Dashboards\Main;
use App\Nova\Domain;
use App\Nova\PanelSetting;
use App\Nova\Room;
use App\Nova\ServiceCheck;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Blade;
use Illuminate\Support\Facades\Gate;
use Laravel\Fortify\Features;
use Laravel\Nova\Badge;
use Laravel\Nova\Menu\Menu;
use Laravel\Nova\Menu\MenuItem;
use Laravel\Nova\Menu\MenuSection;
use Laravel\Nova\Nova;
use Laravel\Nova\NovaApplicationServiceProvider;

class NovaServiceProvider extends NovaApplicationServiceProvider
{
    public function boot(): void
    {
        parent::boot();

        // Locally the app is served from a subdirectory (http://localhost/panel)
        // via an Apache Alias, so Nova's frontend needs the full path from the
        // domain root, not just the configured nova.path segment.
        Nova::provideToScript([
            'base' => parse_url(config('app.url'), PHP_URL_PATH).Nova::path(),
        ]);

        Nova::enableRTL();
        Nova::withBreadcrumbs();
        Nova::initialPath('/dashboards/main');
        Nova::footer(fn () => Blade::render('<p class="text-center">نجوا · پنل مدیریت — محتوای چت‌ها رمزنگاری سرتاسری است و این پنل به آن دسترسی ندارد.</p>'));

        // Sections stay open; the badges are cheap counts on the panel's own
        // SQLite mirror (no calls to the relay or Cloudflare per page view).
        Nova::mainMenu(fn (Request $request) => [
            MenuSection::dashboard(Main::class)->icon('chart-bar'),

            MenuSection::make('چت', [
                MenuItem::resource(Room::class)
                    ->name('اتاق‌ها')
                    ->withBadge(fn () => $this->roomsBadge()),
                MenuItem::link('تنظیمات و قابلیت‌ها', '/resources/panel-settings/1'),
            ])->icon('chat-bubble-left-right'),

            MenuSection::make('سرور و دامنه', [
                MenuItem::resource(ServiceCheck::class)
                    ->name('وضعیت سرویس‌ها')
                    ->withBadge(fn () => $this->servicesBadge()),
                MenuItem::resource(Domain::class)->name('دامنه‌ها و Cloudflare'),
            ])->icon('server'),

            MenuSection::make('امنیت', [
                MenuItem::resource(AdminLog::class)
                    ->name('گزارش امنیتی')
                    ->withBadge(fn () => $this->failedLoginsBadge()),
                MenuItem::link('حساب من (رمز، دومرحله‌ای، passkey)', '/user-security'),
            ])->icon('shield-check'),
        ]);

        Nova::userMenu(fn (Request $request, Menu $menu) => $menu->prepend([
            MenuItem::link('حساب من و امنیت ورود', '/user-security'),
            MenuItem::link('گزارش امنیتی', '/resources/admin-logs'),
        ]));
    }

    private function roomsBadge(): Badge|false
    {
        $online = RoomModel::query()->where('online', '>', 0)->count();
        if ($online > 0) {
            return Badge::make("{$online} آنلاین", 'success');
        }
        $total = RoomModel::query()->count();

        return $total ? Badge::make((string) $total, 'info') : false;
    }

    private function servicesBadge(): Badge
    {
        $bad = ServiceCheckModel::query()->where('status', '!=', 'ok')->count();

        return $bad ? Badge::make("{$bad} مشکل", 'danger') : Badge::make('سالم', 'success');
    }

    private function failedLoginsBadge(): Badge|false
    {
        $failed = AdminLogModel::query()
            ->whereIn('action', ['login.failed', 'lockout'])
            ->where('created_at', '>=', now()->subDay())
            ->count();

        return $failed ? Badge::make("{$failed} ورود ناموفق", 'warning') : false;
    }

    /** Two-factor (TOTP) and passkeys are required; see RequireTwoFactor. */
    protected function fortify(): void
    {
        Nova::fortify()
            ->features([
                Features::updatePasswords(),
                Features::twoFactorAuthentication(['confirm' => true, 'confirmPassword' => true]),
                Features::passkeys(['confirmPassword' => true]),
            ])
            ->register();
    }

    /** No password-reset emails: a lost account is recovered over SSH. */
    protected function routes(): void
    {
        Nova::routes()
            ->withAuthenticationRoutes(default: true)
            ->withoutPasswordResetRoutes()
            ->withoutEmailVerificationRoutes()
            ->register();
    }

    /**
     * Only the listed admin emails get in, and behind Cloudflare Access the
     * panel account must be the same person Access verified.
     */
    protected function gate(): void
    {
        Gate::define('viewNova', function (User $user) {
            $email = strtolower($user->email);
            if (! in_array($email, config('najva.admins'), true)) {
                return false;
            }
            if (config('najva.access.enabled')) {
                return request()->attributes->get('access_email') === $email;
            }

            return true;
        });
    }

    protected function dashboards(): array
    {
        return [new Main];
    }

    public function tools(): array
    {
        return [];
    }

    public function register(): void
    {
        parent::register();
    }
}

<?php

namespace App\Nova\Actions;

use App\Models\AdminLog;
use App\Services\Cloudflare;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Artisan;
use Laravel\Nova\Actions\Action;
use Laravel\Nova\Actions\ActionResponse;
use Laravel\Nova\Fields\ActionFields;
use Laravel\Nova\Http\Requests\NovaRequest;
use Throwable;

class EnforceSecureTls extends Action
{
    public function name(): string
    {
        return 'اعمال تنظیمات امن (Full strict + HTTPS)';
    }

    public function __construct()
    {
        $this->confirmText('SSL روی Full (strict)، HTTPS اجباری و حداقل TLS 1.2 تنظیم می‌شود. سرور دامنه باید گواهی Origin معتبر داشته باشد، وگرنه سایت آن دامنه از دسترس خارج می‌شود.')
            ->confirmButtonText('اعمال')
            ->cancelButtonText('انصراف');
    }

    public function fields(NovaRequest $request): array
    {
        return [];
    }

    public function handle(ActionFields $fields, Collection $models)
    {
        $cf = app(Cloudflare::class);
        foreach ($models as $domain) {
            try {
                $cf->changeSetting($domain->zone_id, 'ssl', 'strict');
                $cf->changeSetting($domain->zone_id, 'always_use_https', 'on');
                $cf->changeSetting($domain->zone_id, 'min_tls_version', '1.2');
            } catch (Throwable) {
                return ActionResponse::danger("تنظیم {$domain->name} انجام نشد (دسترسی توکن را بررسی کنید).");
            }
            AdminLog::record('domains.tls', $domain->name);
        }
        Artisan::call('najva:domains');

        return ActionResponse::message('اعمال شد.');
    }
}

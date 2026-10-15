<?php

namespace App\Nova\Actions;

use App\Models\AdminLog;
use App\Services\Relay;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Artisan;
use Laravel\Nova\Actions\Action;
use Laravel\Nova\Actions\ActionResponse;
use Laravel\Nova\Fields\ActionFields;
use Laravel\Nova\Http\Requests\NovaRequest;
use Throwable;

class RunJanitor extends Action
{
    public function name(): string
    {
        return 'اجرای پاک‌سازی خودکار (همین الان)';
    }

    public function __construct()
    {
        $this->confirmText('محتوای منقضی و قدیمی‌تر از مدت نگه‌داری، طبق قوانین فعلی همین حالا پاک می‌شود.')
            ->confirmButtonText('اجرا')
            ->cancelButtonText('انصراف');
    }

    public function fields(NovaRequest $request): array
    {
        return [];
    }

    public function handle(ActionFields $fields, Collection $models)
    {
        try {
            $r = app(Relay::class)->runJanitor();
        } catch (Throwable) {
            return ActionResponse::danger('سرویس چت پاسخ نداد.');
        }
        AdminLog::record('store.janitor');
        Artisan::call('najva:sync');

        return ActionResponse::message('انجام شد. حجم فعلی: '.round(($r['totalBytes'] ?? 0) / 1048576, 1).' مگابایت');
    }
}

<?php

namespace App\Nova\Actions;

use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Artisan;
use Laravel\Nova\Actions\Action;
use Laravel\Nova\Actions\ActionResponse;
use Laravel\Nova\Fields\ActionFields;
use Laravel\Nova\Http\Requests\NovaRequest;

class RefreshDomains extends Action
{
    public $withoutConfirmation = true;

    public function name(): string
    {
        return 'به‌روزرسانی از Cloudflare';
    }

    public function fields(NovaRequest $request): array
    {
        return [];
    }

    public function handle(ActionFields $fields, Collection $models)
    {
        Artisan::call('najva:domains');

        return ActionResponse::message('اطلاعات دامنه‌ها به‌روز شد.');
    }
}

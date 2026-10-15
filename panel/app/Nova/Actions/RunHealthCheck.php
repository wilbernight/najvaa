<?php

namespace App\Nova\Actions;

use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Artisan;
use Laravel\Nova\Actions\Action;
use Laravel\Nova\Actions\ActionResponse;
use Laravel\Nova\Fields\ActionFields;
use Laravel\Nova\Http\Requests\NovaRequest;

class RunHealthCheck extends Action
{
    public $withoutConfirmation = true;

    public function name(): string
    {
        return 'بررسی دوباره (همین الان)';
    }

    public function fields(NovaRequest $request): array
    {
        return [];
    }

    public function handle(ActionFields $fields, Collection $models)
    {
        Artisan::call('najva:sync');
        Artisan::call('najva:health');

        return ActionResponse::message('بررسی انجام شد.');
    }
}

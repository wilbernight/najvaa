<?php

namespace App\Nova;

use App\Nova\Actions\RunHealthCheck;
use Illuminate\Http\Request;
use Laravel\Nova\Fields\Badge;
use Laravel\Nova\Fields\DateTime;
use Laravel\Nova\Fields\Text;
use Laravel\Nova\Http\Requests\NovaRequest;

class ServiceCheck extends Resource
{
    public static $model = \App\Models\ServiceCheck::class;

    public static $title = 'name';

    public static $search = ['name'];

    public static $globallySearchable = false;

    public static function label(): string
    {
        return 'وضعیت سرویس‌ها';
    }

    public static function singularLabel(): string
    {
        return 'سرویس';
    }

    public static function authorizedToCreate(Request $request): bool
    {
        return false;
    }

    public function authorizedToUpdate(Request $request): bool
    {
        return false;
    }

    public function authorizedToDelete(Request $request): bool
    {
        return false;
    }

    public function authorizedToReplicate(Request $request): bool
    {
        return false;
    }

    public function fields(NovaRequest $request): array
    {
        return [
            Text::make('سرویس', 'name'),
            Badge::make('وضعیت', 'status')
                ->map(['ok' => 'success', 'warn' => 'warning', 'down' => 'danger'])
                ->labels(['ok' => 'سالم', 'warn' => 'هشدار', 'down' => 'مشکل'])
                ->withIcons(),
            Text::make('جزئیات', 'detail'),
            DateTime::make('آخرین بررسی', 'checked_at'),
        ];
    }

    public function actions(NovaRequest $request): array
    {
        return [RunHealthCheck::make()->standalone()];
    }
}

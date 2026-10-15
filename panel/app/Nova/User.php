<?php

namespace App\Nova;

use Illuminate\Http\Request;
use Laravel\Nova\Auth\PasswordValidationRules;
use Laravel\Nova\Fields\Boolean;
use Laravel\Nova\Fields\ID;
use Laravel\Nova\Fields\Password;
use Laravel\Nova\Fields\Text;
use Laravel\Nova\Http\Requests\NovaRequest;

/**
 * Panel accounts. New accounts are only created over SSH
 * (`php artisan nova:user`); from the panel an admin can only edit their own.
 */
class User extends Resource
{
    use PasswordValidationRules;

    public static $model = \App\Models\User::class;

    public static $title = 'name';

    public static $search = ['name', 'email'];

    public static $displayInNavigation = false;

    public static function label(): string
    {
        return 'حساب‌های پنل';
    }

    public static function singularLabel(): string
    {
        return 'حساب';
    }

    public static function authorizedToCreate(Request $request): bool
    {
        return false;
    }

    public function authorizedToUpdate(Request $request): bool
    {
        return $request->user()?->is($this->resource) ?? false;
    }

    public function authorizedToDelete(Request $request): bool
    {
        return false;
    }

    public function authorizedToReplicate(Request $request): bool
    {
        return false;
    }

    public function authorizedToImpersonate(Request $request): bool
    {
        return false;
    }

    public function fields(NovaRequest $request): array
    {
        return [
            ID::make()->sortable(),

            Text::make('نام', 'name')
                ->sortable()
                ->rules('required', 'max:255'),

            Text::make('ایمیل', 'email')
                ->sortable()
                ->readonly()
                ->help('ایمیل فقط از طریق سرور تغییر می‌کند (باید با فهرست ادمین‌ها و Cloudflare Access یکی باشد).'),

            Boolean::make('ورود دومرحله‌ای', fn () => filled($this->two_factor_confirmed_at))->exceptOnForms(),

            Password::make('رمز عبور', 'password')
                ->onlyOnForms()
                ->updateRules($this->optionalPasswordRules()),
        ];
    }
}

<?php

namespace App\Nova\Actions;

use App\Models\AdminLog;
use App\Services\Relay;
use Illuminate\Support\Collection;
use Laravel\Nova\Actions\ActionResponse;
use Laravel\Nova\Actions\DestructiveAction;
use Laravel\Nova\Fields\ActionFields;
use Laravel\Nova\Fields\Text;
use Laravel\Nova\Http\Requests\NovaRequest;
use Throwable;

class DeleteRoom extends DestructiveAction
{
    public function name(): string
    {
        return 'حذف کامل اتاق';
    }

    public function __construct()
    {
        $this->confirmText('همه‌ی پیام‌ها و فایل‌های رمزشده‌ی این اتاق برای همیشه از سرور پاک می‌شوند و دستگاه‌های وصل قطع می‌شوند. برای تأیید، کلمه‌ی «حذف» را بنویسید.')
            ->confirmButtonText('حذف برای همیشه')
            ->cancelButtonText('انصراف');
    }

    public function fields(NovaRequest $request): array
    {
        return [
            Text::make('تأیید', 'confirm')->rules('required', 'in:حذف')->help('بنویسید: حذف'),
        ];
    }

    public function handle(ActionFields $fields, Collection $models)
    {
        $relay = app(Relay::class);
        foreach ($models as $room) {
            try {
                $relay->deleteRoom($room->room_id);
            } catch (Throwable) {
                return ActionResponse::danger('سرویس چت پاسخ نداد؛ اتاق حذف نشد.');
            }
            AdminLog::record('room.deleted', $room->code ?? $room->short_id,['items' => $room->items, 'bytes' => $room->bytes]);
            $room->delete();
        }

        return ActionResponse::message('اتاق حذف شد.');
    }
}

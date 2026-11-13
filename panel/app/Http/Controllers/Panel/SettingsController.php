<?php

namespace App\Http\Controllers\Panel;

use App\Http\Controllers\Controller;
use App\Models\AdminLog;
use App\Models\PanelSetting;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class SettingsController extends Controller
{
    public function edit()
    {
        return view('panel.settings', ['s' => PanelSetting::current()]);
    }

    public function update(Request $request)
    {
        $data = $request->validate([
            'cap_gb' => ['required', 'integer', 'min:1', 'max:500'],
            'max_days' => ['required', 'integer', 'min:1', 'max:3650'],
        ]);
        foreach (['gif', 'preview', 'calls', 'new_rooms'] as $k) {
            $data[$k] = $request->boolean($k);
        }
        try {
            // PanelSetting pushes to the relay first and writes the audit line.
            PanelSetting::current()->update($data);
        } catch (ValidationException $e) {
            return back()->withErrors($e->errors());
        }

        return back()->with('panel.flash', 'تنظیمات ذخیره و روی سرویس چت اعمال شد.');
    }
}

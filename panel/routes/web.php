<?php

use Illuminate\Support\Facades\Route;
use Laravel\Nova\Nova;

// The panel is the whole site.
Route::get('/', fn () => redirect(url(Nova::path())));

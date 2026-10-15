<?php

namespace Laravel\Nova\Rules;

use Illuminate\Database\Eloquent\Model;
use Laravel\Nova\Nova;

class RelatableAttachment extends Relatable
{
    /** {@inheritDoc} */
    #[\Override]
    protected function authorize(string $resourceClass, Model $model): bool
    {
        $parentResource = rescue(
            fn () => $this->request->findResourceOrFail(),
            Nova::newResourceFromModel($this->request->findModelOrFail()),
            false,
        );

        return $parentResource->authorizedToAttachAny(
            $this->request, $model, invertible: true
        ) || $parentResource->authorizedToAttach(
            $this->request, $model, invertible: true
        );
    }

    /** {@inheritDoc} */
    #[\Override]
    protected function relationshipIsFull(Model $model, string $attribute, mixed $value): bool
    {
        return false;
    }
}

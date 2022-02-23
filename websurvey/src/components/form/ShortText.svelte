<script>
    import { createEventDispatcher } from "svelte";
    import { setRequired } from "../../../lib/typewheels/form.js";

    export let field, fieldValue, title;

    const dispatch = createEventDispatcher();
</script>

<label
    for="field-{field.id}"
    class="text-2l font-bold tracking-tight text-slate sm:text-2xl ">{title}</label>
<div>
    <div class="mt-2 mb-2">
        <input
            bind:value={fieldValue}
            on:input={dispatch('add-field-value', fieldValue)}
            required={field.validations.required ? setRequired : null}
            type="text"
            id="field-{field.id}"
            autocomplete="off"
            class="focus:ring-indigo-500 focus:border-indigo-500 block w-full pl-2 pr-2 sm:text-xl border-gray-300 rounded-md pt-2 pb-2"
            placeholder={field.title} />
    </div>
</div>

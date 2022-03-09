<script>
    import { createEventDispatcher } from "svelte";
    import { setRequired, ariaRequired } from "../../../lib/typewheels/form.js";
    import { onMount } from "svelte";

    export let field, fieldValue, title;

    const dispatch = createEventDispatcher();

    const required = field.validations.required;

    let inputElement;

    const inputType = field.type === "email" ? "email" : "text";

    const autocompleteValue = field.type === "email" ? "email" : "off";

    onMount(() => {
        inputElement.type = inputType;
    });
</script>

<label
    for="field-{field.id}"
    class="text-2xl font-bold tracking-tight text-slate sm:text-xl whitespace-pre-line">{title}</label>
<div>
    <div class="mt-2 mb-2">
        <input
            bind:value={fieldValue}
            on:input={dispatch('add-field-value', fieldValue)}
            bind:this={inputElement}
            id="field-{field.id}"
            required={required ? setRequired : null}
            aria-required={ariaRequired(required)}
            type="text"
            class="focus:ring-indigo-500 focus:border-indigo-500 block pl-2 pr-12 sm:text-xl border-gray-300 rounded-md pt-2 pb-2 w-3/4"
            placeholder={field.title}
            autocomplete={autocompleteValue} />
    </div>
</div>

<script>
    import { createEventDispatcher } from "svelte";
    import { setRequired } from "../../../lib/typewheels/form.js";

    export let field, fieldValue, title;

    const dispatch = createEventDispatcher();
</script>

<label
    for="field-{field.id}"
    class="text-2xl font-bold tracking-tight text-slate sm:text-xl whitespace-pre-line">{title}</label>
<div class="space-y-2.5 mb-2">
    {#each field.properties.choices as choice, index (choice.id)}
        <div class="flex flex-row items-center">
            <input
                bind:group={fieldValue}
                on:input={dispatch('add-field-value', fieldValue)}
                required={field.validations.required ? setRequired : null}
                type="radio"
                name="choices"
                value={choice.label}
                class="mr-2" />
            <label
                for="choice-{choice.label}"
                class="sm:text-xl">{choice.label}</label>
        </div>
    {/each}
</div>

<script>
    import { createEventDispatcher } from "svelte";
    import Title from "../text/Title.svelte";

    export let field, fieldValue;

    const dispatch = createEventDispatcher();

    const required = field.validations.required;
</script>

<Title {field} />
<div class="flex flex-col mb-4">
    {#each field.properties.choices as choice, index (choice.id)}
        <label
            for="choice-{choice.id}"
            class="flex flex-row items-center md:w-3/4 mb-2 border-solid rounded border-indigo-500 border-2 p-2 bg-indigo-50 transition-colors ease-linear hover:bg-indigo-200 text-sm md:text-lg text-slate-600 cursor-pointer">
            <input
                bind:group={fieldValue}
                on:input={dispatch('add-field-value', fieldValue)}
                id="choice-{choice.id}"
                {required}
                type="radio"
                name="choices"
                value={choice.label}
                class="mr-2" />{choice.label}
        </label>
    {/each}
</div>

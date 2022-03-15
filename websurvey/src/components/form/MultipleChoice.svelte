<script>
    import { createEventDispatcher } from "svelte";
    import Title from "../text/Title.svelte";

    export let field, fieldValue;

    const dispatch = createEventDispatcher();

    const required = field.validations.required;
</script>

<Title {field} />
<div class="space-y-2.5 mb-2">
    {#each field.properties.choices as choice, index (choice.id)}
        <fieldset class="flex flex-row items-center">
            <legend />
            <input
                bind:group={fieldValue}
                on:input={dispatch('add-field-value', fieldValue)}
                id="choice-{choice.id}"
                {required}
                type="radio"
                name="choices"
                value={choice.label}
                class="mr-2" />
            <label
                for="choice-{choice.id}"
                class="text-sm sm:text-xl">{choice.label}
            </label>
        </fieldset>
    {/each}
</div>

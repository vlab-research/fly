<script>
    import { createEventDispatcher } from "svelte";
    import { setRequired, ariaRequired } from "../../../lib/typewheels/form.js";
    import Title from "../text/Title.svelte";

    export let field, fieldValue;

    const dispatch = createEventDispatcher();

    const required = field.validations.required;
</script>

<Title {field} />
<div class="space-y-2.5 mb-2">
    {#each field.properties.choices as choice, index (choice.id)}
        <div class="flex flex-row items-center">
            <input
                bind:group={fieldValue}
                on:input={dispatch('add-field-value', fieldValue)}
                id="choice-{choice.label}"
                required={required ? setRequired : null}
                aria-required={ariaRequired(required)}
                type="radio"
                name="choices"
                value={choice.label}
                class="mr-2" />
            <label
                for="choice-{choice.label}"
                class="text-sm sm:text-xl">{choice.label}
            </label>
        </div>
    {/each}
</div>

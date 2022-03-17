<script>
    import { createEventDispatcher } from "svelte";
    import Title from "../text/Title.svelte";

    export let field, fieldValue;

    const dispatch = createEventDispatcher();

    const required = field.validations.required;
</script>

<Title {field} />
<div class="flex flex-col mb-4">
    <fieldset>
        {#each field.properties.choices as choice, index (choice.id)}
            <div class="flex flex-row items-center mb-2">
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
                    class="text-sm md:text-lg">{choice.label}
                </label>
            </div>
        {/each}
    </fieldset>
</div>

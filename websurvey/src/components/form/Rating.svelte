<script>
    import { createEventDispatcher } from "svelte";
    import Title from "../text/Title.svelte";

    export let field, fieldValue;

    const required = field.validations.required;

    const dispatch = createEventDispatcher();

    const { properties } = field;

    const { steps } = properties;

    const arr = [];

    const count = () => {
        for (let i = 0; i < steps; i++) {
            arr.push(i);
        }
    };

    count();
</script>

<Title {field} />
<div class="mb-4 w-full">
    <div class="flex flex-row w-full justify-between items-start">
        {#each arr as e, i}
            <label
                for="label-{e}"
                class="text-sm md:text-lg flex flex-col items-center border-solid rounded border-indigo-500 border-2 px-2 py-1 md:px-4 md:py-2 bg-indigo-100 transition-colors ease-linear hover:bg-indigo-200 text-sm md:text-lg text-slate-600 cursor-pointer">
                <input
                    bind:group={fieldValue}
                    on:input={dispatch('add-field-value', fieldValue)}
                    id="label-{e}"
                    {required}
                    type="radio"
                    name="steps"
                    value={e}
                    class="mb-2" />{e}</label>
        {/each}
    </div>
</div>
